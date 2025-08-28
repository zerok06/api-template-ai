
import mysql from "mysql2/promise";
import { config } from "../config";

const HOST = config.mysql.host
const USER = config.mysql.user
const PASSWORD = config.mysql.password
const DATABASE = config.mysql.database

const db_connection = mysql.createPool({
    host: HOST,
    user: USER,
    password: PASSWORD,
    database: DATABASE,
});

const query = async (sql: string, params: any[]): Promise<any[] | any> => {
    const [rows] = await db_connection.query(sql, params);
    return rows;
};

export const db = {
    query,
};