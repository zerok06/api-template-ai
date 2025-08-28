import express from 'express'
import morgan from 'morgan'
import cors from 'cors'
import dotenv from 'dotenv'
import openAI from './routes/openai'
import Kommo from './routes/kommo'

dotenv.config()

const app = express()
const port = process.env.PORT || 3000


// config
app.use(morgan('dev'))
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// routes


app.use('/openai', openAI)
app.use('/kommo', Kommo)

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})