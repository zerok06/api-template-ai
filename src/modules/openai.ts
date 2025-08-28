import { config } from '../config';
import OpenAI from "openai";
import type { ChatCompletionCreateParams } from 'openai/resources/chat/completions';
import moment from 'moment-timezone';
import fs from 'fs'
import path from 'path'

type OpenAIModel = ChatCompletionCreateParams['model'];

// Definición de tipos
interface Tool {
    name: string;
    function: (...args: any[]) => any | Promise<any>;
}

interface AssistantResponse {
    output: string;
    thread_id: string;
}

interface OpenAIAssistantConfig {
    maxRetries?: number;
    timeout?: number;
    pollInterval?: number;
}

class OpenAIAssistantError extends Error {
    constructor(message: string, public code?: string) {
        super(message);
        this.name = 'OpenAIAssistantError';
    }
}

const createOpenAIAssistant = async (tools: Tool[] = [], assistant_id: string, assistantConfig: OpenAIAssistantConfig = { maxRetries: 3, pollInterval: 1000, timeout: 60000 }) => {
    const {
        maxRetries = 3,
        timeout = 60000,
        pollInterval = 1000
    } = assistantConfig;

    // Validar configuración
    if (!config.openai?.key) {
        throw new OpenAIAssistantError('OpenAI API key is required');
    }

    if (!assistant_id) {
        throw new OpenAIAssistantError('OpenAI Assistant ID is required');
    }

    const client = new OpenAI({
        apiKey: config.openai.key,
        timeout: timeout
    });

    let assistant: OpenAI.Beta.Assistants.Assistant;

    try {
        // Verificar que el assistant existe
        assistant = await client.beta.assistants.retrieve(assistant_id);
    } catch (error) {
        throw new OpenAIAssistantError(`Failed to retrieve assistant: ${error}`);
    }

    // Mapear tools para OpenAI
    const toolsMap = new Map<string, Tool>();
    tools.forEach(tool => {
        if (!tool.name || typeof tool.function !== 'function') {
            throw new OpenAIAssistantError(`Invalid tool: ${tool.name}. Must have name and function properties`);
        }
        toolsMap.set(tool.name, tool);
    });

    /**
     * Procesa tool calls de OpenAI
     */
    const processToolCalls = async (toolCalls: OpenAI.Beta.Threads.Runs.RequiredActionFunctionToolCall[]) => {
        const toolOutputs: OpenAI.Beta.Threads.Runs.RunSubmitToolOutputsParams.ToolOutput[] = [];

        for (const toolCall of toolCalls) {
            const toolName = toolCall.function.name;
            const tool = toolsMap.get(toolName);

            if (!tool) {
                console.warn(`Tool "${toolName}" not found in registered tools`);
                toolOutputs.push({
                    tool_call_id: toolCall.id,
                    output: JSON.stringify({ error: `Tool "${toolName}" not found` })
                });
                continue;
            }

            try {
                const args = JSON.parse(toolCall.function.arguments || '{}');
                console.log(`Executing tool: ${toolName} with args:`, args);

                const result = await tool.function(args);

                toolOutputs.push({
                    tool_call_id: toolCall.id,
                    output: typeof result === 'string' ? result : JSON.stringify(result)
                });
            } catch (error) {
                console.error(`Error executing tool "${toolName}":`, error);
                toolOutputs.push({
                    tool_call_id: toolCall.id,
                    output: JSON.stringify({ error: `Failed to execute tool: ${error}` })
                });
            }
        }

        return toolOutputs;
    };

    /**
     * Espera a que el run se complete
     */
    const waitForRunCompletion = async (threadId: string, runId: string): Promise<OpenAI.Beta.Threads.Runs.Run> => {
        let attempts = 0;
        const maxAttempts = Math.ceil(timeout / pollInterval);

        while (attempts < maxAttempts) {
            try {
                const run = await client.beta.threads.runs.retrieve(runId, { thread_id: threadId });

                switch (run.status) {
                    case 'completed':
                        return run;

                    case 'requires_action':
                        if (run.required_action?.type === 'submit_tool_outputs') {
                            const toolCalls = run.required_action.submit_tool_outputs.tool_calls;
                            const toolOutputs = await processToolCalls(toolCalls);

                            await client.beta.threads.runs.submitToolOutputs(runId, { thread_id: threadId, tool_outputs: toolOutputs });
                        }
                        break;

                    case 'failed':
                        throw new OpenAIAssistantError(`Run failed: ${run.last_error?.message || 'Unknown error'}`);

                    case 'cancelled':
                        throw new OpenAIAssistantError('Run was cancelled');

                    case 'expired':
                        throw new OpenAIAssistantError('Run expired');
                }

                await new Promise(resolve => setTimeout(resolve, pollInterval));
                attempts++;
            } catch (error) {
                if (error instanceof OpenAIAssistantError) {
                    throw error;
                }
                throw new OpenAIAssistantError(`Error checking run status: ${error}`);
            }
        }

        throw new OpenAIAssistantError('Run timeout: Assistant did not respond within the specified time limit');
    };

    const response = async (message: string, thread_id?: string): Promise<AssistantResponse> => {
        if (!message?.trim()) {
            throw new OpenAIAssistantError('Message cannot be empty');
        }
        const currentTime = moment().tz(config.server.timezone).format('[Hoy es] dddd D [de] MMMM [de] YYYY, [son las] HH:mm [hora de Ecuador]');
        let currentThreadId = thread_id;
        let retryCount = 0;

        while (retryCount < maxRetries) {
            try {
                // Crear thread si no existe
                if (!currentThreadId) {
                    const thread = await client.beta.threads.create();
                    currentThreadId = thread.id;
                }

                // Agregar mensaje al thread
                await client.beta.threads.messages.create(currentThreadId, {
                    role: 'user',
                    content: message + "\n" + currentTime
                });

                // Ejecutar el assistant
                const run = await client.beta.threads.runs.create(currentThreadId, {
                    assistant_id: assistant.id
                });

                // Esperar a que termine
                await waitForRunCompletion(currentThreadId, run.id);

                // Obtener mensajes
                const messages = await client.beta.threads.messages.list(currentThreadId, {
                    order: 'desc',
                    limit: 1
                });

                if (!messages.data.length) {
                    throw new OpenAIAssistantError('No response received from assistant');
                }

                const lastMessage = messages.data[0];

                if (lastMessage.role !== 'assistant') {
                    throw new OpenAIAssistantError('Last message is not from assistant');
                }

                // Extraer texto de la respuesta
                const textContent = lastMessage.content
                    .filter(content => content.type === 'text')
                    .map(content => (content as any).text.value)
                    .join('\n');

                if (!textContent) {
                    throw new OpenAIAssistantError('No text content found in assistant response');
                }

                return {
                    output: textContent,
                    thread_id: currentThreadId
                };

            } catch (error) {
                retryCount++;

                if (retryCount >= maxRetries) {
                    if (error instanceof OpenAIAssistantError) {
                        throw error;
                    }
                    throw new OpenAIAssistantError(`Failed after ${maxRetries} attempts: ${error}`);
                }

                console.warn(`Attempt ${retryCount} failed, retrying...`, error);
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            }
        }

        throw new OpenAIAssistantError('Unexpected error in response method');
    };

    const deleteThread = async (thread_id: string): Promise<void> => {
        try {
            await client.beta.threads.delete(thread_id);
        } catch (error) {
            throw new OpenAIAssistantError(`Failed to delete thread: ${error}`);
        }
    };

    const getAssistantInfo = () => ({
        id: assistant.id,
        name: assistant.name,
        description: assistant.description,
        model: assistant.model,
        tools: assistant.tools?.length || 0,
        registeredTools: tools.length
    });

    return {
        response,
        deleteThread,
        getAssistantInfo,
        client // Para operaciones avanzadas
    };
};

async function downloadFile(url: string, filepath: string): Promise<void> {
    try {
        const response = await fetch(url)

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`)
        }

        const buffer = await response.arrayBuffer()
        fs.writeFileSync(filepath, Buffer.from(buffer))
    } catch (error) {
        console.error('Error downloading file:', error)
        throw new Error('Failed to download file')
    }
}

// Función para procesar mensajes de voz
async function processVoiceMessage(attachmentUrl: string): Promise<string> {
    const openai = new OpenAI({
        apiKey: config.openai.key,
    })
    try {
        const tempFilePath = path.join(__dirname, '../temp', `voice_${Date.now()}.m4a`)

        // Crear directorio temp si no existe
        const tempDir = path.dirname(tempFilePath)
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true })
        }

        // Descargar el archivo de voz
        await downloadFile(attachmentUrl, tempFilePath)

        // Convertir voz a texto usando Whisper
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempFilePath),
            model: "whisper-1",
            language: "es"
        })

        // Limpiar archivo temporal
        fs.unlinkSync(tempFilePath)

        return transcription.text
    } catch (error) {
        console.error('Error processing voice message:', error)
        throw new OpenAIAssistantError('Failed to process voice message')
    }
}

// Función para procesar imágenes
async function processPictureMessage(attachmentUrl: string): Promise<string> {
    const openai = new OpenAI({
        apiKey: config.openai.key,
    });
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Describe esta imagen en detalle y extrae cualquier texto que puedas ver en ella. Responde en formato JSON con las claves: 'descripcion' y 'texto_extraido'."
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: attachmentUrl
                            }
                        }
                    ]
                }
            ],
            max_tokens: 1000
        })

        return response.choices[0].message.content || "No se pudo procesar la imagen"
    } catch (error) {
        console.error('Error processing picture message:', error)
        throw new OpenAIAssistantError('Failed to process picture message')
    }
}

// Función para procesar archivos
async function processFileMessage(attachmentUrl: string, fileName: string): Promise<string> {
    try {
        const fileExtension = path.extname(fileName).toLowerCase()
        const tempFilePath = path.join(__dirname, '../temp', `file_${Date.now()}${fileExtension}`)

        // Crear directorio temp si no existe
        const tempDir = path.dirname(tempFilePath)
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true })
        }

        // Descargar archivo
        await downloadFile(attachmentUrl, tempFilePath)

        let extractedText = ""

        switch (fileExtension) {
            case '.pdf':
                extractedText = "Procesamiento de PDF implementado - requiere librería pdf-parse"
                break
            case '.xlsx':
            case '.xls':
                extractedText = "Procesamiento de Excel implementado - requiere librería xlsx"
                break
            case '.txt':
                extractedText = fs.readFileSync(tempFilePath, 'utf8')
                break
            case '.docx':
                extractedText = "Procesamiento de Word implementado - requiere librería mammoth"
                break
            default:
                extractedText = `Tipo de archivo no soportado: ${fileExtension}`
        }

        // Limpiar archivo temporal
        fs.unlinkSync(tempFilePath)

        return JSON.stringify({
            tipo_archivo: fileExtension,
            nombre_archivo: fileName,
            texto_extraido: extractedText,
            procesado_en: new Date().toISOString()
        })

    } catch (error) {
        console.error('Error processing file message:', error)
        throw new OpenAIAssistantError('Failed to process file message')
    }
}

async function agenteBase(prompt: string, text: string, model: OpenAIModel = "gpt-4o-mini", temperature: number = 0, max_tokens: number = 1000) {
    const openai = new OpenAI({ apiKey: config.openai.key });

    try {
        const response = await openai.chat.completions.create({
            model,
            messages: [
                {
                    role: "system",
                    content: prompt
                },
                {
                    role: "user",
                    content: text
                }
            ],
            max_tokens,
            temperature,
        });

        return response.choices[0].message.content || "No se pudo procesar el texto";
    } catch (error) {
        console.error('Error en agenteBase:', error);
        throw new Error('Failed to process text with agenteBase');
    }
}


async function agenteStructure(prompt, text, jsonExample, model: OpenAIModel = "gpt-4o-mini", temperature: number = 0) {
    const openai = new OpenAI({ apiKey: config.openai.key });

    const systemPrompt = `${prompt}

Debes responder ÚNICAMENTE en formato JSON válido siguiendo esta estructura exacta:
${JSON.stringify(jsonExample, null, 2)}

Importante: Tu respuesta debe ser un JSON válido que pueda ser parseado directamente.`;

    try {
        const response = await openai.chat.completions.create({
            model,
            messages: [
                {
                    role: "system",
                    content: systemPrompt
                },
                {
                    role: "user",
                    content: text
                }
            ],
            max_tokens: 1000,
            response_format: { type: "json_object" },
            temperature,
        });

        const content = response.choices[0].message.content;

        if (!content) {
            throw new Error("No se recibió contenido en la respuesta");
        }

        try {
            return JSON.parse(content);
        } catch (parseError) {
            console.error('Error parsing JSON response:', parseError);
            console.error('Raw content:', content);
            throw new Error('Failed to parse JSON response');
        }
    } catch (error) {
        console.error('Error en agenteStructure:', error);
        throw new Error('Failed to process text with agenteStructure');
    }
}



export default createOpenAIAssistant;
export { OpenAIAssistantError, agenteBase, agenteStructure, type Tool, type AssistantResponse, type OpenAIAssistantConfig, processFileMessage, processPictureMessage, processVoiceMessage };