import * as mysqlClient from '../modules/mysql'

let mysql: typeof mysqlClient

declare global {
    var mysql: typeof mysqlClient | undefined
}

if (process.env.NODE_ENV == 'production') {
    mysql = mysqlClient
} else {
    if (!global.mysql) {
        global.mysql = mysqlClient
    }
    mysql = global.mysql
}

export default mysql