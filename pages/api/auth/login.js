import { getCoreDb } from "@/lib/db/coreDb";
import { verifyPassword } from "@/lib/auth/password";
import { signToken } from "@/lib/auth/jwt";

import { getUserFromToken } from "@/lib/auth/clientAuth";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  const { tenantSlug, email, password } = req.body;

  if (!tenantSlug || !email || !password) {
    return res.status(400).json({
      error: "tenantSlug, email, and password are required",
    });
  }

  const db = getCoreDb();

  async function handleUser() {
    try {
      const userz = await getUserFromToken();
    } catch (error) {
      console.error("Error fetching user:", error);
    }
  }

  handleUser();

  /* -------------------------------------------------
     1. Resolve tenant
  ------------------------------------------------- */
  const [tenantRows] = await db.query(
    `
    SELECT id, slug, name
    FROM tenants
    WHERE slug = ?
      AND is_active = 1
    `,
    [tenantSlug]
  );

  if (!tenantRows.length) {
    return res.status(401).json({
      error: "Invalid tenant or credentials",
    });
  }

  const tenant = tenantRows[0];

  /* -------------------------------------------------
     2. Resolve user
  ------------------------------------------------- */
  const [userRows] = await db.query(
    `
    SELECT id, email, password_hash, role, is_active
    FROM users
    WHERE email = ?
      AND is_active = 1
    `,
    [email]
  );

  if (!userRows.length) {
    return res.status(401).json({
      error: "Invalid tenant or credentials",
    });
  }

  const user = userRows[0];

  /* -------------------------------------------------
     3. Validate user ↔ tenant relationship
  ------------------------------------------------- */
  const [linkRows] = await db.query(
    `
    SELECT role
    FROM user_tenants
    WHERE user_id = ?
      AND tenant_id = ?
    `,
    [user.id, tenant.id]
  );

  if (!linkRows.length) {
    return res.status(403).json({
      error: "User is not allowed to access this tenant",
    });
  }

  const tenantRole = linkRows[0].role;

  /* -------------------------------------------------
     4. Validate password
  ------------------------------------------------- */
  const validPassword = await verifyPassword(password, user.password_hash);

  if (!validPassword) {
    return res.status(401).json({
      error: "Invalid tenant or credentials",
    });
  }

  /* -------------------------------------------------
     5. Issue JWT (EXPLICIT tenant binding)
  ------------------------------------------------- */
  const token = signToken({
    userId: user.id,
    email: user.email,
    role: user.role, // SYSTEM_ADMIN / TENANT_USER
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    tenantId: tenant.id,
    tenantRole, // ADMIN / USER
  });

  /* -------------------------------------------------
     6. Respond
  ------------------------------------------------- */
  res.json({
    token,
    tenant: {
      slug: tenant.slug,
      name: tenant.name,
      role: tenantRole,
    },
    user: {
      email: user.email,
      role: user.role,
    },
  });
}
