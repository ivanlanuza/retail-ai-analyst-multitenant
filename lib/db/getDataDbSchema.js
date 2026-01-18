// lib/db/getDataDbSchema.js
import { SqlDatabase } from "@langchain/classic/sql_db";
import { DataSource } from "typeorm";

//Singleton SqlDatabase instance (important for Next dev HMR)
let sqlDbPromise = null;

export function getSqlDb(tenant) {
  if (!sqlDbPromise) {
    const dataSource = new DataSource({
      type: "mysql",
      host: tenant.data_db_host,
      port: Number(tenant.data_db_port || "3306"),
      username: tenant.data_db_user,
      password: tenant.data_db_password,
      database: tenant.data_db_name,
    });

    sqlDbPromise = SqlDatabase.fromDataSourceParams({
      appDataSource: dataSource,
      includesTables: parseTableList(tenant.table_list),
      sampleRowsInTableInfo: 2,
    });
  }
  return sqlDbPromise;
}

//Converts list of data tables from tenant table into an array
function parseTableList(tableList) {
  if (Array.isArray(tableList)) return tableList;
  if (!tableList) return [];
  return String(tableList)
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

//Get current schema description as text for use in the prompt.

export async function getDataDbSchema(tenant) {
  const db = await getSqlDb(tenant);
  const schema = await db.getTableInfo(parseTableList(tenant.table_list));
  console.log(schema);
  return schema;
}
