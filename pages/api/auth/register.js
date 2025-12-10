// pages/api/auth/register.js
import { getDb } from "../../../lib/db.mjs";
import { hashPassword, signToken, setAuthCookie } from "../../../lib/auth";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { email, password, name } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  if (password.length < 8) {
    return res
      .status(400)
      .json({ error: "Password must be at least 8 characters" });
  }

  try {
    const db = getDb();

    // Check if user exists
    const [existing] = await db.query("SELECT id FROM users WHERE email = ?", [
      email,
    ]);
    if (existing.length > 0) {
      return res.status(409).json({ error: "Email is already registered" });
    }

    const passwordHash = await hashPassword(password);

    const [result] = await db.query(
      "INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)",
      [email, passwordHash, name || null]
    );

    const userId = result.insertId;
    const token = signToken({ userId });

    setAuthCookie(res, token);

    return res.status(201).json({
      message: "User registered successfully",
      user: {
        id: userId,
        email,
        name: name || null,
      },
    });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
