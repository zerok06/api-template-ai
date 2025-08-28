import dotenv from 'dotenv'

dotenv.config()

export const config = {
    openai: {
        key: process.env.OPENAI_API_KEY || '',
        assistant_id: process.env.OPENAI_ASSISTANT_ID || ''
    },
    kommo: {
        subdomain: process.env.KOMMO_SUBDOMAIN || '',
        api_secret: process.env.KOMMO_API_SECRET || '',
        field_id: process.env.KOMMO_FIELD_ID ? parseInt(process.env.KOMMO_FIELD_ID) : 0,
        bot_id: process.env.KOMMO_BOT_ID ? parseInt(process.env.KOMMO_BOT_ID) : 0,
        thread_id: process.env.KOMMO_THREAD_ID ? parseInt(process.env.KOMMO_THREAD_ID) : 0
    },
    redis: {
        url: process.env.REDIS_URL || '',
        password: process.env.REDIS_PASSWORD || ''
    },
    server: {
        timezone: process.env.SERVER_TIMEZONE || 'UTC'
    },
    mysql: {
        host: process.env.MYSQL_HOST || 'localhost',
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || 'senha',
        database: process.env.MYSQL_DATABASE || 'mysql'
    }
}
