//import { getAppDbConnection } from "@/lib/db/appDb";
import { getRequestContext } from "@/lib/requestContext";

import { getCoreDb } from "../db/coreDb";

export async function getTenantContext(req, tenantId) {
  const ctx = getRequestContext(req);

  if (ctx.tenant && ctx.tenant.id === tenantId) {
    return ctx.tenant;
  }

  //const db = await getAppDbConnection();

  const db = await getCoreDb();

  const [rows] = await db.query(
    `
    SELECT
      id,
      slug,
      data_db_host,
      data_db_name,
      data_db_user,
      data_db_password,
      qdrant_collection,
      scope_filter,
      table_list,
      data_db_type
    FROM tenants
    WHERE id = ? 
    AND is_active = 1
    LIMIT 1
    `,
    [tenantId]
  );

  if (!rows.length) {
    throw new Error(`Tenant ${tenantId} not found`);
  }

  ctx.tenant = rows[0];
  return rows[0];
}
