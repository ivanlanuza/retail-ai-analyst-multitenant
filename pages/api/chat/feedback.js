// pages/api/chat/feedback.js
import mysql from "mysql2/promise";
import { getUserFromRequest } from "../../../lib/auth";

// Reuse a single pool across hot reloads / requests
function getPool() {
  if (!global._mysqlPool) {
    global._mysqlPool = mysql.createPool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: process.env.DB_POOL_LIMIT
        ? Number(process.env.DB_POOL_LIMIT)
        : 10,
      queueLimit: 0,
      // Important for emojis + full unicode
      charset: "utf8mb4",
    });
  }
  return global._mysqlPool;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { conversationId, messageId, rating, reason } = req.body || {};

  if (!conversationId || !messageId) {
    return res
      .status(400)
      .json({ error: "conversationId and messageId are required" });
  }

  if (rating !== "up" && rating !== "down") {
    return res.status(400).json({ error: 'rating must be "up" or "down"' });
  }

  const trimmedReason =
    typeof reason === "string" ? reason.trim().slice(0, 2000) : null;

  try {
    const pool = getPool();

    // Upsert: if user already rated this message, update it
    await pool.execute(
      `
      INSERT INTO chat_answer_feedback
        (user_id, conversation_id, message_id, rating, reason)
      VALUES
        (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        conversation_id = VALUES(conversation_id),
        rating = VALUES(rating),
        reason = VALUES(reason),
        updated_at = CURRENT_TIMESTAMP
      `,
      [
        user.id,
        String(conversationId),
        String(messageId),
        rating,
        trimmedReason || null,
      ]
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Feedback insert failed:", err);
    return res.status(500).json({ error: "Failed to save feedback" });
  }
}
