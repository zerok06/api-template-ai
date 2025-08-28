import { Router } from 'express'
import type { Request, Response } from 'express'
import agente, { Tool, OpenAIAssistantError, processFileMessage, processPictureMessage, processVoiceMessage, agenteBase } from '../modules/openai'
import kommo from '../global/kommo'
import { config } from '../config'
import MessageBatchManager, { BatchResult, MessageData } from '../adapters/redis'

const router = Router()

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


// Función para verificar si hay un flujo activo


const messageBatchManager = new MessageBatchManager()

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

        // Agregar mensaje a Redis
        const messageData = {
            message: processedMessage,
            message_id: req.body['message[add][0][id]'],
            message_type: attachmentType || 'text',
            date: new Date().toISOString()
        }


        const batchInfo = await messageBatchManager.addMessage(
            lead_id,
            messageData,
            async (batchResult: BatchResult): Promise<string> => {
                try {
                    console.log(`Processing batch of ${batchResult.messageCount} messages for lead ${batchResult.lead_id}`)

                    // Obtener thread_id del lead
                    const thread_id_user = (await kommo.lead.find(batchResult.lead_id))?.custom_fields_values
                        ?.find((lead) => lead.field_id === config.kommo.thread_id)?.values[0]?.value || null

                    console.log('Thread ID:', thread_id_user)
                    let threadId: string | null = thread_id_user as string | null

                    // Procesar con el agente de IA
                    const assistant = await agente(tools, config.openai.assistant_id)
                    const { output, thread_id } = await assistant.response(batchResult.combinedMessage, threadId)

                    console.log('AI response:', output)

                    // Actualizar el lead en Kommo con la respuesta
                    await kommo.lead.update(batchResult.lead_id, {
                        custom_fields_values: [{
                            field_id: config.kommo.field_id,
                            values: [{ value: output }]
                        }]
                    })

                    // Actualizar thread_id si es necesario
                    if (thread_id && thread_id !== thread_id_user) {
                        await kommo.lead.update(batchResult.lead_id, {
                            custom_fields_values: [{
                                field_id: config.kommo.thread_id,
                                values: [{ value: thread_id }]
                            }]
                        })
                    }

                    // Ejecutar bot en Kommo
                    await kommo.bot.execute(batchResult.lead_id, '2', config.kommo.bot_id)

                    return output

                } catch (error) {
                    console.error('Error processing message batch with AI:', error)
                    throw error
                }

            }
        )

        console.log(`Message received for lead ${lead_id}. Flow: ${batchInfo.isNewFlow ? 'NEW' : 'CONTINUING'}`)

        if (batchInfo.shouldProcessImmediately) {
            const lastResponse = await messageBatchManager.getLastResponse(lead_id)

            return res.json({
                message: lastResponse?.response || "Procesado correctamente",
                processed_messages: lastResponse?.processed_messages || 0,
                processing_mode: 'immediate_close',
                status: 'flow_closed',
                lead_id: lead_id
            })
        }

        res.json({
            message: "Mensaje recibido y agregado al lote",
            lead_id: lead_id,
            processing_mode: batchInfo.isNewFlow ? 'batch_new' : 'batch_continue',
            messages_in_batch: batchInfo.messagesInBatch,
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



export default router