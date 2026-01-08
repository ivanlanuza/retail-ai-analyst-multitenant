import mysql from "mysql2/promise";
import { getCoreDb } from "../db/coreDb";
import { QdrantClient } from "@qdrant/js-client-rest";

const dataDbPools = new Map();

export async function getTenantBySlug(slug) {
  const db = getCoreDb();
  const [rows] = await db.query(
    `SELECT * FROM tenants WHERE slug = ? AND is_active = 1`,
    [slug]
  );

  if (!rows.length) return null;
  return rows[0];
}

export async function getDataDbConnection(tenant) {
  const key = tenant.id;

  if (!dataDbPools.has(key)) {
    dataDbPools.set(
      key,
      mysql.createPool({
        host: tenant.data_db_host,
        user: tenant.data_db_user,
        password: tenant.data_db_password,
        database: tenant.data_db_name,
        waitForConnections: true,
        connectionLimit: 10,
      })
    );
  }

  return dataDbPools.get(key);
}

export function getQdrantClient() {
  return new QdrantClient({
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY,
  });
}
