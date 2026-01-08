import { coreQuery } from "@/lib/db/coreDb";

function deriveConversationTitle(question) {
  const trimmed = String(question || "").trim();
  if (!trimmed) return "New conversation";
  return trimmed.length > 80 ? trimmed.slice(0, 77) + "..." : trimmed;
}

export async function ensureConversationAndPersistUserMessage({
  conversationId,
  question,
  user,
  streamError,
}) {
  let convId = conversationId || null;

  if (!convId) {
    const title = deriveConversationTitle(question);
    const convResult = await coreQuery(
      "INSERT INTO conversations (tenant_id, user_id, title) VALUES (?, ?, ?)",
      [user.tenantId, user.userId, title]
    );
    convId = convResult.insertId;
  } else {
    const existing = await coreQuery(
      "SELECT id FROM conversations WHERE id = ? AND user_id = ? AND tenant_id = ?",
      [convId, user.userId, user.tenantId]
    );
    if (existing.length === 0) {
      streamError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
      return null;
    }
  }

  const userMsgResult = await coreQuery(
    "INSERT INTO messages (conversation_id, tenant_id, role, content) VALUES (?, ?, ?, ?)",
    [convId, user.tenantId, "user", question.trim()]
  );

  return {
    convId,
    userMessageId: userMsgResult.insertId,
  };
}
