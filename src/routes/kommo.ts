import { Router } from 'express'
import type { Request, Response } from 'express'
import agente, { Tool, OpenAIAssistantError, processFileMessage, processPictureMessage, processVoiceMessage } from '../modules/openai'
import kommo from '../global/kommo'
import redis from '../modules/redis'
import { config } from '../config'

const router = Router()
const redisControl = redis()

// Configuración para el batching de mensajes
const MESSAGE_DELAY = 5000 // 5 segundos de espera después del último mensaje
const MAX_BATCH_SIZE = 10 // Máximo 10 mensajes por lote
const MAX_WAIT_TIME = 30000 // Máximo 30 segundos de espera total

const tools: Tool[] = [
    {
        name: 'buscar_numero_menor',
        function: async (args: { numeros: number[] }) => {
            if (!Array.isArray(args.numeros) || args.numeros.length === 0) {
                throw new OpenAIAssistantError('Invalid input: numeros must be a non-empty array');
            }
            return Math.min(...args.numeros);
        }
    },
    {
        name: 'hora_actual',
        function: async () => {
            return new Date().toLocaleTimeString();
        }
    }
]

// Función para descargar archivo desde URL usando fetch

// Función para procesar un lote de mensajes con la IA y enviar respuesta
async function processMessageBatch(lead_id: number, messages: any[]): Promise<string> {
    try {
        console.log(`Processing batch of ${messages.length} messages for lead ${lead_id}`)

        // Combinar todos los mensajes en un contexto
        const combinedMessage = messages.map((msg, index) => {
            const messageData = JSON.parse(msg)
            return `Mensaje ${index + 1} (${messageData.date}): ${messageData.message}`
        }).join('\n\n')

        console.log('Combined message:', combinedMessage)

        const thread_id_user = (await kommo.lead.find(lead_id))?.custom_fields_values?.find((lead) => lead.field_id === config.kommo.thread_id)?.values[0]?.value || null
        console.log(thread_id_user)

        let threadId: string | null = thread_id_user as string | null

        const assistant = await agente(tools)
        const { output, thread_id } = await assistant.response(combinedMessage, threadId)

        console.log('AI response:', output)

        await kommo.lead.update(lead_id, { custom_fields_values: [{ field_id: config.kommo.field_id, values: [{ value: output }] }] })
        if (thread_id == null) {
            await kommo.lead.update(lead_id, { custom_fields_values: [{ field_id: config.kommo.thread_id, values: [{ value: thread_id }] }] })
        }
        await kommo.bot.execute(lead_id, '2', config.kommo.bot_id)

        return output

    } catch (error) {
        console.error('Error processing message batch:', error)
        throw error
    }
}

// Función para procesar y cerrar el flujo
async function processAndCloseFlow(lead_id: number): Promise<void> {
    const processingKey = `lead:${lead_id}:processing`

    try {
        // Marcar como procesando para evitar procesamientos duplicados
        const isProcessing = await redisControl.setNX(processingKey, '1')
        if (!isProcessing) {
            console.log(`Lead ${lead_id} already being processed, skipping...`)
            return
        }

        // Establecer expiración del lock de procesamiento
        await redisControl.expire(processingKey, 60) // 60 segundos de timeout

        console.log(`Processing and closing flow for lead ${lead_id}`)

        // Obtener todos los mensajes pendientes
        const messages = await redisControl.lRange(`lead:${lead_id}:messages`, 0, -1)

        if (messages.length === 0) {
            console.log(`No messages to process for lead ${lead_id}`)
            return
        }

        // Procesar el lote de mensajes
        const aiResponse = await processMessageBatch(lead_id, messages)

        // Guardar la respuesta de la IA (opcional, para logging)
        const responseData = {
            response: aiResponse,
            processed_messages: messages.length,
            processed_at: new Date().toISOString(),
            status: 'completed'
        }

        await redisControl.setEx(`lead:${lead_id}:last_response`, 300, JSON.stringify(responseData)) // Expira en 5 minutos

        console.log(`Successfully processed ${messages.length} messages for lead ${lead_id}. Flow closed.`)

    } catch (error) {
        console.error(`Error processing batch for lead ${lead_id}:`, error)

        // Guardar error para debugging
        const errorData = {
            error: error instanceof Error ? error.message : 'Unknown error',
            processed_at: new Date().toISOString(),
            status: 'error'
        }

        await redisControl.setEx(`lead:${lead_id}:last_response`, 300, JSON.stringify(errorData))

    } finally {
        // IMPORTANTE: Limpiar TODO para cerrar completamente el flujo
        await redisControl.del(`lead:${lead_id}:messages`)      // Limpiar mensajes procesados
        await redisControl.del(`lead:${lead_id}:timer`)         // Limpiar timer
        await redisControl.del(`lead:${lead_id}:batch_start`)   // Limpiar inicio de lote
        await redisControl.del(processingKey)                   // Limpiar lock de procesamiento

        console.log(`Flow completely closed for lead ${lead_id}. Ready for new messages.`)
    }
}

// Función para programar el procesamiento del lote
async function scheduleMessageProcessing(lead_id: number): Promise<void> {
    const timerKey = `lead:${lead_id}:timer`
    const batchStartKey = `lead:${lead_id}:batch_start`

    // Cancelar timer anterior si existe
    const existingTimer = await redisControl.get(timerKey) as string
    if (existingTimer) {
        clearTimeout(parseInt(existingTimer))
        console.log(`Cancelled existing timer for lead ${lead_id}`)
    }

    // Si no existe batch_start, establecer el tiempo de inicio
    const batchStart = await redisControl.get(batchStartKey)
    if (!batchStart) {
        await redisControl.setEx(batchStartKey, MAX_WAIT_TIME / 1000, Date.now().toString())
        console.log(`Started new batch for lead ${lead_id}`)
    }

    // Crear nuevo timer
    const timerId = setTimeout(async () => {
        console.log(`Timer expired for lead ${lead_id} - Processing and closing flow`)
        await processAndCloseFlow(lead_id)
    }, MESSAGE_DELAY)

    // Guardar el ID del timer
    await redisControl.setEx(timerKey, (MESSAGE_DELAY + 5000) / 1000, timerId.toString())

    console.log(`Scheduled processing for lead ${lead_id} in ${MESSAGE_DELAY}ms`)
}

// Función para verificar si se debe procesar inmediatamente
async function shouldProcessImmediately(lead_id: string): Promise<boolean> {
    const messageCount = Number(await redisControl.lLen(`lead:${lead_id}:messages`))
    const batchStart = await redisControl.get(`lead:${lead_id}:batch_start`) as string

    // Procesar si alcanzamos el máximo de mensajes
    if (messageCount >= MAX_BATCH_SIZE) {
        console.log(`Max batch size reached for lead ${lead_id} - Processing immediately`)
        return true
    }

    // Procesar si alcanzamos el tiempo máximo de espera
    if (batchStart) {
        const startTime = parseInt(batchStart)
        const elapsedTime = Date.now() - startTime
        if (elapsedTime >= MAX_WAIT_TIME) {
            console.log(`Max wait time reached for lead ${lead_id} - Processing immediately`)
            return true
        }
    }

    return false
}

// Función para verificar si hay un flujo activo
async function hasActiveFlow(lead_id: string): Promise<boolean> {
    const messageCount = Number(await redisControl.lLen(`lead:${lead_id}:messages`))
    const hasTimer = Number(await redisControl.exists(`lead:${lead_id}:timer`))
    const isProcessing = Number(await redisControl.exists(`lead:${lead_id}:processing`))

    return messageCount > 0 || hasTimer > 0 || isProcessing > 0
}

router.post('/webhook/', async (req: Request, res: Response) => {
    try {
        const lead_id = req.body['message[add][0][entity_id]']
        const PIPELINE_ID = 11848656
        const STATUS_ID: number[] = [91256951]

        const leadData = await kommo.lead.find(lead_id)

        if (Number(leadData.pipeline_id) !== PIPELINE_ID || !STATUS_ID.includes(Number(leadData.status_id))) {
            return res.status(400).json({ error: 'Invalid lead data' });
        }

        let processedMessage = ""
        const attachmentType = req.body['message[add][0][attachment][type]']
        const attachmentUrl = req.body['message[add][0][attachment][link]']
        const fileName = req.body['message[add][0][attachment][name]'] || 'file'
        const textMessage = req.body['message[add][0][text]']

        // Procesar según el tipo de mensaje
        if (attachmentType === 'voice') {
            console.log('Processing voice message...')
            processedMessage = await processVoiceMessage(attachmentUrl)
            console.log('Voice transcription:', processedMessage)

        } else if (attachmentType === 'picture') {
            console.log('Processing picture message...')
            processedMessage = await processPictureMessage(attachmentUrl)
            console.log('Picture analysis:', processedMessage)

        } else if (attachmentType === 'file') {
            console.log('Processing file message...')
            processedMessage = await processFileMessage(attachmentUrl, fileName)
            console.log('File content:', processedMessage)

        } else if (textMessage && textMessage !== '') {
            console.log('Processing text message...')
            processedMessage = textMessage
        } else {
            processedMessage = "Error al leer mensaje enviado."
        }

        // Verificar si hay un flujo activo (mensajes pendientes, timer o procesamiento)
        const hasActive = await hasActiveFlow(lead_id)

        console.log(`Message received for lead ${lead_id}. Active flow: ${hasActive}`)

        // Agregar mensaje a Redis
        const messageData = {
            message: processedMessage,
            message_id: req.body['message[add][0][id]'],
            message_type: attachmentType || 'text',
            date: new Date().toISOString()
        }

        await redisControl.lPush(`lead:${lead_id}:messages`, JSON.stringify(messageData))
        console.log(`Added message to batch for lead ${lead_id}. ${hasActive ? 'Continuing' : 'Starting new'} flow.`)

        // Verificar si debemos procesar inmediatamente
        const shouldProcess = await shouldProcessImmediately(lead_id)

        if (shouldProcess) {
            // Procesar inmediatamente y cerrar flujo
            console.log(`Processing immediately for lead ${lead_id} and closing flow`)
            await processAndCloseFlow(lead_id)

            // Obtener la respuesta procesada
            const lastResponseData = await redisControl.get(`lead:${lead_id}:last_response`) as string
            const lastResponse = lastResponseData ? JSON.parse(lastResponseData) : null

            return res.json({
                message: lastResponse?.response || "Procesado correctamente",
                processed_messages: lastResponse?.processed_messages || 0,
                processing_mode: 'immediate_close',
                status: 'flow_closed'
            })
        } else {
            // Programar procesamiento con delay - el flujo se cerrará cuando expire el timer
            await scheduleMessageProcessing(lead_id)
        }

        // Respuesta para indicar que el mensaje fue recibido y está en cola
        const messagesInBatch = await redisControl.lLen(`lead:${lead_id}:messages`)

        res.json({
            message: "Mensaje recibido y agregado al lote",
            lead_id: lead_id,
            processing_mode: hasActive ? 'batch_continue' : 'batch_new',
            messages_in_batch: messagesInBatch,
            status: 'flow_active'
        })

    } catch (error) {
        console.error('Webhook error:', error)
        res.status(500).json({
            error: 'Internal server error',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
})

// Endpoint para obtener el estado del procesamiento
router.get('/status/:lead_id', async (req: Request, res: Response) => {
    try {
        const { lead_id } = req.params

        const messagesInBatch = await redisControl.lLen(`lead:${lead_id}:messages`)
        const lastResponse = await redisControl.get(`lead:${lead_id}:last_response`) as string
        const isProcessing = await redisControl.exists(`lead:${lead_id}:processing`)
        const batchStart = await redisControl.get(`lead:${lead_id}:batch_start`) as string

        res.json({
            lead_id,
            messages_in_batch: messagesInBatch,
            is_processing: Boolean(isProcessing),
            batch_started_at: batchStart ? new Date(parseInt(batchStart)).toISOString() : null,
            last_response: lastResponse ? JSON.parse(lastResponse) : null
        })

    } catch (error) {
        console.error('Status error:', error)
        res.status(500).json({
            error: 'Internal server error',
            details: error instanceof Error ? error.message : 'Unknown error'
        })
    }
})

export default router