// lib/sqlDb.js
import { SqlDatabase } from "@langchain/classic/sql_db";
import { DataSource } from "typeorm";

/**
 * Singleton SqlDatabase instance (important for Next dev HMR)
 */
let sqlDbPromise = null;

export function getSqlDb() {
  if (!sqlDbPromise) {
    const dataSource = new DataSource({
      type: "mysql",
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || "3306"),
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });

    sqlDbPromise = SqlDatabase.fromDataSourceParams({
      appDataSource: dataSource,
      includesTables: ["members", "metrics", "genders", "locations"],
      sampleRowsInTableInfo: 2,
    });
  }
  return sqlDbPromise;
}

/**
 * Get current schema description as text for use in the prompt.
 */
export async function getSchemaText() {
  const db = await getSqlDb();
  const schema = await db.getTableInfo([
    "members",
    "metrics",
    "genders",
    "locations",
  ]);
  return schema;
}
