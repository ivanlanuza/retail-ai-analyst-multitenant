// pages/api/auth/logout.js
import { clearAuthCookie } from "../../../lib/auth";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  clearAuthCookie(res);
  return res.redirect(307, "/");
}
