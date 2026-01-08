import { getCoreDb } from "@/lib/db/coreDb";
import { hashPassword } from "@/lib/auth/password";
import { requireAuth } from "@/lib/auth/requireAuth";

export default requireAuth(async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  const { email, password, tenantSlug: bodyTenantSlug } = req.body;
  const { role: actorRole, tenantSlug: actorTenantSlug } = req.user;

  // --------------------------------------------------
  // 1. Authorization
  // --------------------------------------------------
  if (actorRole !== "SYSTEM_ADMIN" && actorRole !== "TENANT_ADMIN") {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  // --------------------------------------------------
  // 2. Determine tenant scope
  // --------------------------------------------------
  let tenantSlug;

  if (actorRole === "SYSTEM_ADMIN") {
    if (!bodyTenantSlug) {
      return res.status(400).json({ error: "tenantSlug is required" });
    }
    tenantSlug = bodyTenantSlug;
  } else {
    // TENANT_ADMIN
    tenantSlug = actorTenantSlug;
  }

  const db = getCoreDb();
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    // --------------------------------------------------
    // 3. Ensure email uniqueness
    // --------------------------------------------------
    const [existing] = await conn.query(
      `SELECT id FROM users WHERE email = ?`,
      [email]
    );

    if (existing.length) {
      throw new Error("User with this email already exists");
    }

    // --------------------------------------------------
    // 4. Resolve tenant
    // --------------------------------------------------
    const [tenantRows] = await conn.query(
      `SELECT id FROM tenants WHERE slug = ? AND is_active = 1`,
      [tenantSlug]
    );

    if (!tenantRows.length) {
      throw new Error("Tenant not found");
    }

    const tenantId = tenantRows[0].id;

    // --------------------------------------------------
    // 5. Create user (TENANT_USER only)
    // --------------------------------------------------
    const passwordHash = await hashPassword(password);

    const [userResult] = await conn.query(
      `INSERT INTO users (email, password_hash, role, is_active)
       VALUES (?, ?, 'TENANT_USER', 1)`,
      [email, passwordHash]
    );

    const userId = userResult.insertId;

    // --------------------------------------------------
    // 6. Link user to tenant
    // --------------------------------------------------
    await conn.query(
      `INSERT INTO user_tenants (user_id, tenant_id, role)
       VALUES (?, ?, 'TENANT_USER')`,
      [userId, tenantId]
    );

    await conn.commit();

    return res.status(201).json({ success: true });
  } catch (err) {
    await conn.rollback();
    return res.status(400).json({ error: err.message });
  } finally {
    conn.release();
  }
});
