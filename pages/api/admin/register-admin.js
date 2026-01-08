import { requireSystemAdmin } from "@/lib/auth/requireAuth";
import { getCoreDb } from "@/lib/db/coreDb";
import { hashPassword } from "@/lib/auth/password";

export default requireSystemAdmin(async function handler(req, res) {
  console.log("Register admin API called");
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { email, password, role, tenantSlug } = req.body;

  // --------------------------------------------------
  // 1. Basic validation
  // --------------------------------------------------
  if (!email || !password || !role) {
    return res.status(400).json({
      error: "email, password, and role are required",
    });
  }

  if (!["SYSTEM_ADMIN", "TENANT_ADMIN"].includes(role)) {
    return res.status(400).json({
      error: "Invalid role for this endpoint",
    });
  }

  if (role === "TENANT_ADMIN" && !tenantSlug) {
    return res.status(400).json({
      error: "tenantSlug is required for TENANT_ADMIN",
    });
  }

  const db = getCoreDb();

  // --------------------------------------------------
  // 2. Ensure email is unique
  // --------------------------------------------------
  const [existingUsers] = await db.query(
    `SELECT id FROM users WHERE email = ?`,
    [email]
  );

  if (existingUsers.length > 0) {
    return res.status(409).json({
      error: "User with this email already exists",
    });
  }

  // --------------------------------------------------
  // 3. Resolve tenant (only for TENANT_ADMIN)
  // --------------------------------------------------
  let tenantId = null;

  if (role === "TENANT_ADMIN") {
    const [tenants] = await db.query(
      `
      SELECT id
      FROM tenants
      WHERE slug = ?
        AND is_active = 1
      `,
      [tenantSlug]
    );

    if (tenants.length === 0) {
      return res.status(400).json({
        error: "Invalid tenant",
      });
    }

    tenantId = tenants[0].id;
  }

  // --------------------------------------------------
  // 4. Create user
  // --------------------------------------------------
  const passwordHash = await hashPassword(password);

  const [userResult] = await db.query(
    `
    INSERT INTO users (email, password_hash, role, is_active)
    VALUES (?, ?, ?, 1)
    `,
    [email, passwordHash, role]
  );

  const userId = userResult.insertId;

  // --------------------------------------------------
  // 5. Link TENANT_ADMIN to tenant
  // --------------------------------------------------
  if (role === "TENANT_ADMIN") {
    await db.query(
      `
      INSERT INTO user_tenants (user_id, tenant_id, role)
      VALUES (?, ?, 'TENANT_ADMIN')
      `,
      [userId, tenantId]
    );
  }

  // --------------------------------------------------
  // 6. Success response
  // --------------------------------------------------
  return res.status(201).json({
    success: true,
    user: {
      id: userId,
      email,
      role,
    },
  });
});
