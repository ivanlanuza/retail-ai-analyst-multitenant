//import { getAppDbConnection } from "@/lib/db/appDb";

import { getCoreDb } from "../db/coreDb";

export async function assertTenantAccess(user) {
  if (!user) {
    throw new Error("Invalid user or tenant");
  }

  if (user.role === "SYSTEM_ADMIN") {
    return true;
  }

  //const db = await getAppDbConnection();

  const db = await getCoreDb();

  const [rows] = await db.query(
    `
    SELECT 1
    FROM user_tenants
    WHERE user_id = ?
      AND tenant_id = ?
    LIMIT 1
    `,
    [user.userId, user.tenantId]
  );

  if (!rows.length) {
    const err = new Error("User does not have access to this tenant");
    err.code = "TENANT_ACCESS_DENIED";
    throw err;
  }

  return true;
}
