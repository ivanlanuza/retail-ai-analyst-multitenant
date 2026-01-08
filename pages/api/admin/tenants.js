import { getCoreDb } from "@/lib/db/coreDb";
import { requireSystemAdmin } from "@/lib/auth/requireAuth";

export default requireSystemAdmin(async function handler(req, res) {
  //console.log("Received request for tenants:", req.method, req.url);
  if (req.method !== "GET") {
    return res.status(405).end();
  }

  const db = getCoreDb();

  const [rows] = await db.query(
    `
    SELECT id, name, slug
    FROM tenants
    WHERE is_active = 1
    ORDER BY name
    `
  );

  //console.log("Fetched tenants:", rows);

  res.json(rows);
});
