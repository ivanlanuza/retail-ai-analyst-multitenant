// pages/api/chat/ask.js
import { getDb } from "../../../lib/db";
import { getUserFromRequest } from "../../../lib/auth";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { conversationId, question } = req.body || {};

  if (
    !question ||
    typeof question !== "string" ||
    question.trim().length === 0
  ) {
    return res.status(400).json({ error: "Question is required" });
  }

  const db = getDb();

  try {
    let convId = conversationId || null;

    // 1) Ensure conversation exists or create a new one
    if (!convId) {
      const title = question.trim().slice(0, 80);
      const [convResult] = await db.query(
        "INSERT INTO conversations (user_id, title) VALUES (?, ?)",
        [user.id, title]
      );
      convId = convResult.insertId;
    } else {
      // Make sure it belongs to the current user
      const [existing] = await db.query(
        "SELECT id FROM conversations WHERE id = ? AND user_id = ?",
        [convId, user.id]
      );
      if (existing.length === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }
    }

    // 2) Insert user message
    const [userMsgResult] = await db.query(
      "INSERT INTO messages (conversation_id, user_id, role, content) VALUES (?, ?, ?, ?)",
      [convId, user.id, "user", question.trim()]
    );
    const userMessageId = userMsgResult.insertId;

    // 3) Insert placeholder assistant message
    const placeholder = "Deciding how to proceed…";
    const [assistantMsgResult] = await db.query(
      "INSERT INTO messages (conversation_id, user_id, role, content) VALUES (?, ?, ?, ?)",
      [convId, null, "assistant", placeholder]
    );
    const assistantMessageId = assistantMsgResult.insertId;

    // 4) (Optional future) create sql_queries, token_usage rows here

    // 5) Return full conversation messages (so frontend has entire thread)
    const [messages] = await db.query(
      "SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
      [convId]
    );

    return res.status(200).json({
      conversationId: convId,
      messages,
      // placeholder status to make it easy to add more updates later
      status: "in_progress",
    });
  } catch (err) {
    console.error("Error in /api/chat/ask:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
