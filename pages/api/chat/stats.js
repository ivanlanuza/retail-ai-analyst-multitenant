// pages/api/chat/stats.js
import { requireAuth } from "@/lib/auth/requireAuth";
import { coreQuery } from "@/lib/db/coreDb";

export default requireAuth(async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = req.user;
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { conversationId } = req.query;
  if (!conversationId) {
    return res.status(400).json({ error: "conversationId is required" });
  }

  try {
    // Ensure conversation belongs to this user
    const convRows = await coreQuery(
      "SELECT id FROM conversations WHERE id = ? AND user_id = ?",
      [conversationId, user.userId]
    );
    if (convRows.length === 0) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const sqlQueries = await coreQuery(
      `SELECT id, sql_text, status, rows_returned, error_message, duration_ms, created_at
       FROM sql_queries
       WHERE conversation_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 10`,
      [conversationId]
    );

    const tokenUsage = await coreQuery(
      `SELECT id, model, prompt_tokens, completion_tokens, total_tokens, created_at
       FROM token_usage
       WHERE conversation_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 10`,
      [conversationId]
    );

    return res.status(200).json({
      sqlQueries,
      tokenUsage,
    });
  } catch (err) {
    console.error("Error in /api/chat/stats:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});
