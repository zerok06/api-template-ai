import dotenv from 'dotenv'

dotenv.config()

export const config = {
    openai: {
        key: process.env.OPENAI_API_KEY || ''
    }
}