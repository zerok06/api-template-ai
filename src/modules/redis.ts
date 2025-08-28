import { createClient } from "redis";
import { config } from "../config";


const redis = () => {
    const redisClient = createClient({
        url: config.redis.url,
        password: config.redis.password
    })
    redisClient.on("error", (err) => console.error("Redis error:", err))
    redisClient.connect()

    return redisClient
}




export default redis