// pages/api/chat/conversations.js
import { requireAuth } from "@/lib/auth/requireAuth";
import { coreQuery } from "@/lib/db/coreDb";

export default requireAuth(async function handler(req, res) {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method === "GET") {
    return getConversations(req, res, user);
  }

  return res.status(405).json({ error: "Method not allowed" });
});

async function getConversations(req, res, user) {
  try {
    const rows = await coreQuery(
      `
      SELECT
        c.id,
        c.title,
        c.status,
        c.created_at,
        c.updated_at,
        (
          SELECT m.content
          FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1
        ) AS last_message
      FROM conversations c
      WHERE c.user_id = ?
      AND c.tenant_id = ?
      ORDER BY c.updated_at DESC, c.id DESC
      `,
      [user.userId, user.tenantId]
    );

    return res.status(200).json({ conversations: rows });
  } catch (err) {
    console.error("Error in /api/chat/conversations:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
