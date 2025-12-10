// lib/db.js
import mysql from "mysql2/promise";

let pool;

export function getDb() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || "3306"),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
  }
  return pool;
}

/**
 * Simple helper: returns only rows.
 */
export async function query(sql, params = []) {
  const db = getDb();
  const [rows] = await db.execute(sql, params);
  return rows;
}

/**
 * Returns rows + fields (for building table column headers on the UI).
 */
export async function queryWithFields(sql, params = []) {
  const db = getDb();
  const [rows, fields] = await db.execute(sql, params);
  return { rows, fields };
}

/**
 * Optional: direct pool export if you ever need lower-level access.
 */
export { pool };
