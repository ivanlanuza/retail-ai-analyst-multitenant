import mysql from "mysql2/promise";
import { queryWithPool, queryWithFieldsWithPool } from "./helpers.js";

let pool;

export function getCoreDb() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.CORE_DB_HOST,
      user: process.env.CORE_DB_USER,
      password: process.env.CORE_DB_PASSWORD,
      database: process.env.CORE_DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
    });
  }
  return pool;
}

export async function coreQuery(sql, params = []) {
  return queryWithPool(getCoreDb(), sql, params);
}

export async function coreQueryWithFields(sql, params = []) {
  return queryWithFieldsWithPool(getCoreDb(), sql, params);
}

export { pool };
