import { kommo as kommoClient } from '../modules/kommo'

let kommo: typeof kommoClient

declare global {
    var kommo: typeof kommoClient | undefined
}

if (process.env.NODE_ENV == 'production') {
    kommo = kommoClient
} else {
    if (!global.kommo) {
        global.kommo = kommoClient
    }
    kommo = global.kommo
}

export default kommo