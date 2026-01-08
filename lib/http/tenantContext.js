// lib/http/tenantContext.js

import { assertTenantAccess } from "@/lib/auth/assertTenantAccess";
import { getTenantContext } from "@/lib/tenants/getTenantContext";

export async function requireUserAndTenant(req, streamError) {
  const user = req.user;

  if (!user) {
    streamError(401, "UNAUTHORIZED", "Unauthorized");
    return null;
  }

  try {
    await assertTenantAccess(user);
  } catch (err) {
    streamError(403, "FORBIDDEN", "Tenant access denied");
    return null;
  }

  let tenant;
  try {
    tenant = await getTenantContext(req, user.tenantId);
  } catch (err) {
    streamError(404, "TENANT_NOT_FOUND", "Tenant not found");
    return null;
  }

  return { user, tenant };
}
