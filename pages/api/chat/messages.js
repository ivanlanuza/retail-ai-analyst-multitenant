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
    // Ensure conversation belongs to user
    const convRows = await coreQuery(
      "SELECT id FROM conversations WHERE id = ? AND user_id = ?",
      [conversationId, user.userId]
    );
    if (convRows.length === 0) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const messages = await coreQuery(
      "SELECT id, role, content, answer_payload, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
      [conversationId]
    );

    return res.status(200).json({ messages });
  } catch (err) {
    console.error("Error in /api/chat/messages:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});
