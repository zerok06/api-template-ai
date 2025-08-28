import redis from '../modules/redis'

const redisControl = redis()

export const BATCH_CONFIG = {
    MESSAGE_DELAY: 5000,      // 5 segundos de espera después del último mensaje
    MAX_BATCH_SIZE: 10,       // Máximo 10 mensajes por lote
    MAX_WAIT_TIME: 30000,     // Máximo 30 segundos de espera total
    PROCESSING_TIMEOUT: 60,    // 60 segundos de timeout para el lock
    RESPONSE_TTL: 300         // 5 minutos de TTL para la respuesta
}

export interface MessageData {
    message: string
    message_id: string
    message_type: string
    date: string
}

export interface BatchResult {
    messages: MessageData[]
    lead_id: number
    combinedMessage: string
    messageCount: number
}

export interface ProcessingCallback {
    (batchResult: BatchResult): Promise<string>
}

export class MessageBatchManager {
    private timers: Map<number, NodeJS.Timeout> = new Map()

    async addMessage(lead_id: number, messageData: MessageData, onProcessBatch: ProcessingCallback): Promise<{
        shouldProcessImmediately: boolean
        messagesInBatch: number
        isNewFlow: boolean
    }> {
        // Verificar si hay un flujo activo
        const isNewFlow = !(await this.hasActiveFlow(lead_id))

        // Agregar mensaje a Redis
        await redisControl.lPush(`lead:${lead_id}:messages`, JSON.stringify(messageData))
        console.log(`Added message to batch for lead ${lead_id}. ${!isNewFlow ? 'Continuing' : 'Starting new'} flow.`)

        // Verificar si debemos procesar inmediatamente
        const shouldProcessImmediately = await this.shouldProcessImmediately(lead_id)

        if (shouldProcessImmediately) {
            // Procesar inmediatamente y cerrar flujo
            console.log(`Processing immediately for lead ${lead_id} and closing flow`)
            await this.processAndCloseFlow(lead_id, onProcessBatch)
        } else {
            // Programar procesamiento con delay
            await this.scheduleMessageProcessing(lead_id, onProcessBatch)
        }

        const messagesInBatch = Number(await redisControl.lLen(`lead:${lead_id}:messages`))

        return {
            shouldProcessImmediately,
            messagesInBatch,
            isNewFlow
        }
    }

    /**
     * Obtiene el estado actual del procesamiento para un lead
     */
    async getProcessingStatus(lead_id: number): Promise<{
        lead_id: number
        messages_in_batch: number
        is_processing: boolean
        batch_started_at: string | null
        last_response: any
    }> {
        const messagesInBatchRaw = await redisControl.lLen(`lead:${lead_id}:messages`)
        const messagesInBatch = Number(messagesInBatchRaw)
        const lastResponse = await redisControl.get(`lead:${lead_id}:last_response`) as string
        const isProcessing = await redisControl.exists(`lead:${lead_id}:processing`)
        const batchStart = await redisControl.get(`lead:${lead_id}:batch_start`) as string

        return {
            lead_id,
            messages_in_batch: messagesInBatch,
            is_processing: Boolean(isProcessing),
            batch_started_at: batchStart ? new Date(parseInt(batchStart)).toISOString() : null,
            last_response: lastResponse ? JSON.parse(lastResponse) : null
        }
    }

    /**
     * Obtiene la última respuesta procesada
     */
    async getLastResponse(lead_id: number): Promise<any> {
        const lastResponseData = await redisControl.get(`lead:${lead_id}:last_response`) as string
        return lastResponseData ? JSON.parse(lastResponseData) : null
    }

    /**
     * Procesa un lote de mensajes y cierra el flujo
     */
    private async processAndCloseFlow(lead_id: number, onProcessBatch: ProcessingCallback): Promise<void> {
        const processingKey = `lead:${lead_id}:processing`

        try {
            // Marcar como procesando para evitar procesamientos duplicados
            const isProcessing = await redisControl.setNX(processingKey, '1')
            if (!isProcessing) {
                console.log(`Lead ${lead_id} already being processed, skipping...`)
                return
            }

            // Establecer expiración del lock de procesamiento
            await redisControl.expire(processingKey, BATCH_CONFIG.PROCESSING_TIMEOUT)

            console.log(`Processing and closing flow for lead ${lead_id}`)

            // Obtener todos los mensajes pendientes
            const messages = await redisControl.lRange(`lead:${lead_id}:messages`, 0, -1)

            if (messages.length === 0) {
                console.log(`No messages to process for lead ${lead_id}`)
                return
            }

            // Preparar los datos del lote
            const parsedMessages: MessageData[] = messages.map(msg => JSON.parse(typeof msg === 'string' ? msg : msg.toString()))

            // Combinar todos los mensajes en un contexto
            const combinedMessage = parsedMessages.map((msg, index) => {
                return `Mensaje ${index + 1} (${msg.date}): ${msg.message}`
            }).join('\n\n')

            console.log('Combined message:', combinedMessage)

            const batchResult: BatchResult = {
                messages: parsedMessages,
                lead_id,
                combinedMessage,
                messageCount: messages.length
            }

            // Llamar al callback de procesamiento (aquí es donde se ejecutará el agente)
            const aiResponse = await onProcessBatch(batchResult)

            // Guardar la respuesta de la IA
            const responseData = {
                response: aiResponse,
                processed_messages: messages.length,
                processed_at: new Date().toISOString(),
                status: 'completed'
            }

            await redisControl.setEx(
                `lead:${lead_id}:last_response`,
                BATCH_CONFIG.RESPONSE_TTL,
                JSON.stringify(responseData)
            )

            console.log(`Successfully processed ${messages.length} messages for lead ${lead_id}. Flow closed.`)

        } catch (error) {
            console.error(`Error processing batch for lead ${lead_id}:`, error)

            // Guardar error para debugging
            const errorData = {
                error: error instanceof Error ? error.message : 'Unknown error',
                processed_at: new Date().toISOString(),
                status: 'error'
            }

            await redisControl.setEx(
                `lead:${lead_id}:last_response`,
                BATCH_CONFIG.RESPONSE_TTL,
                JSON.stringify(errorData)
            )

        } finally {
            // IMPORTANTE: Limpiar TODO para cerrar completamente el flujo
            await this.cleanupFlow(lead_id)
            console.log(`Flow completely closed for lead ${lead_id}. Ready for new messages.`)
        }
    }

    /**
     * Programa el procesamiento del lote con un delay
     */
    private async scheduleMessageProcessing(lead_id: number, onProcessBatch: ProcessingCallback): Promise<void> {
        const timerKey = `lead:${lead_id}:timer`
        const batchStartKey = `lead:${lead_id}:batch_start`

        // Cancelar timer anterior si existe
        const existingTimer = this.timers.get(lead_id)
        if (existingTimer) {
            clearTimeout(existingTimer)
            this.timers.delete(lead_id)
            console.log(`Cancelled existing timer for lead ${lead_id}`)
        }

        // Si no existe batch_start, establecer el tiempo de inicio
        const batchStart = await redisControl.get(batchStartKey)
        if (!batchStart) {
            await redisControl.setEx(
                batchStartKey,
                BATCH_CONFIG.MAX_WAIT_TIME / 1000,
                Date.now().toString()
            )
            console.log(`Started new batch for lead ${lead_id}`)
        }

        // Crear nuevo timer
        const timerId = setTimeout(async () => {
            console.log(`Timer expired for lead ${lead_id} - Processing and closing flow`)
            this.timers.delete(lead_id)
            await this.processAndCloseFlow(lead_id, onProcessBatch)
        }, BATCH_CONFIG.MESSAGE_DELAY)

        // Guardar el timer en memoria y Redis
        this.timers.set(lead_id, timerId)
        await redisControl.setEx(
            timerKey,
            (BATCH_CONFIG.MESSAGE_DELAY + 5000) / 1000,
            'active'
        )

        console.log(`Scheduled processing for lead ${lead_id} in ${BATCH_CONFIG.MESSAGE_DELAY}ms`)
    }

    /**
     * Verifica si se debe procesar inmediatamente
     */
    private async shouldProcessImmediately(lead_id: number): Promise<boolean> {
        const messageCount = Number(await redisControl.lLen(`lead:${lead_id}:messages`))
        const batchStart = await redisControl.get(`lead:${lead_id}:batch_start`) as string

        // Procesar si alcanzamos el máximo de mensajes
        if (messageCount >= BATCH_CONFIG.MAX_BATCH_SIZE) {
            console.log(`Max batch size reached for lead ${lead_id} - Processing immediately`)
            return true
        }

        // Procesar si alcanzamos el tiempo máximo de espera
        if (batchStart) {
            const startTime = parseInt(batchStart)
            const elapsedTime = Date.now() - startTime
            if (elapsedTime >= BATCH_CONFIG.MAX_WAIT_TIME) {
                console.log(`Max wait time reached for lead ${lead_id} - Processing immediately`)
                return true
            }
        }

        return false
    }

    /**
     * Verifica si hay un flujo activo
     */
    private async hasActiveFlow(lead_id: number): Promise<boolean> {
        const messageCount = Number(await redisControl.lLen(`lead:${lead_id}:messages`))
        const hasTimer = Number(await redisControl.exists(`lead:${lead_id}:timer`))
        const isProcessing = Number(await redisControl.exists(`lead:${lead_id}:processing`))

        return messageCount > 0 || hasTimer > 0 || isProcessing > 0
    }

    /**
     * Limpia todos los datos de Redis relacionados con el flujo
     */
    private async cleanupFlow(lead_id: number): Promise<void> {
        await Promise.all([
            redisControl.del(`lead:${lead_id}:messages`),      // Limpiar mensajes procesados
            redisControl.del(`lead:${lead_id}:timer`),         // Limpiar timer
            redisControl.del(`lead:${lead_id}:batch_start`),   // Limpiar inicio de lote
            redisControl.del(`lead:${lead_id}:processing`)     // Limpiar lock de procesamiento
        ])

        // Limpiar timer de memoria si existe
        const timer = this.timers.get(lead_id)
        if (timer) {
            clearTimeout(timer)
            this.timers.delete(lead_id)
        }
    }
}

export default MessageBatchManager