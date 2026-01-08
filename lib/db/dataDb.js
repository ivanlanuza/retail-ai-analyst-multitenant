import mysql from "mysql2/promise";
import { queryWithPool, queryWithFieldsWithPool } from "./helpers";

const pools = new Map();

export async function getDataDbConnectionForTenant(tenant) {
  if (!pools.has(tenant.id)) {
    const pool = mysql.createPool({
      host: tenant.data_db_host,
      user: tenant.data_db_user,
      password: tenant.data_db_password,
      database: tenant.data_db_name,
      waitForConnections: true,
      connectionLimit: 10,
    });

    pools.set(tenant.id, pool);
  }

  return pools.get(tenant.id);
}

/* Tenant-scoped helpers */
export async function tenantQuery(tenant, sql, params = []) {
  const pool = getDataDbConnectionForTenant(tenant);
  return queryWithPool(pool, sql, params);
}

export async function tenantQueryWithFields(tenant, sql, params = []) {
  const pool = getDataDbConnectionForTenant(tenant);
  return queryWithFieldsWithPool(pool, sql, params);
}
