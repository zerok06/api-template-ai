import * as redisClient from '../modules/redis'

let redis: typeof redisClient

declare global {
    var redis: typeof redisClient | undefined
}

if (process.env.NODE_ENV == 'production') {
    redis = redisClient
} else {
    if (!global.redis) {
        global.redis = redisClient
    }
    redis = global.redis
}

export default redis