// lib/chat/buildContext.js
// Helpers for building prompt/context pieces for /api/chat/ask

import { coreQuery } from "@/lib/db/coreDb";
import { createQdrantHelper } from "@/lib/vector/qdrantManagement";

function extractLastQAPairs(messages, maxPairs = 2) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const pairs = [];

  for (const m of messages) {
    if (m.role === "user") {
      pairs.push({ question: m.content || "", answer: null });
      if (pairs.length > maxPairs) pairs.shift();
      continue;
    }

    if (m.role === "assistant" && pairs.length > 0) {
      const last = pairs[pairs.length - 1];
      if (last && !last.answer) last.answer = m.content || "";
    }
  }

  return pairs;
}

function formatRecentQAPairsForContext(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return "";

  return pairs
    .map((p, idx) => {
      const n = idx + 1;
      const q = (p.question || "").trim();
      const a = (p.answer || "").trim();
      const lines = [];
      if (q) lines.push(`Q${n}: ${q}`);
      if (a) lines.push(`A${n}: ${a}`);
      return lines.join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

export async function buildConversationSummary({ convId, tenantId }) {
  let conversationSummaryForPrompt = "";

  try {
    const rows = await coreQuery(
      "SELECT conversation_summary FROM conversations WHERE id = ? AND tenant_id = ?",
      [convId, tenantId]
    );

    if (Array.isArray(rows) && rows.length > 0) {
      conversationSummaryForPrompt = rows[0].conversation_summary || "";
    }
  } catch (err) {
    console.error("Error fetching conversation summary:", err);
  }

  return conversationSummaryForPrompt;
}

export async function getUserLongTermMemorySummary(user) {
  const rows = await coreQuery(
    "SELECT memory_summary FROM user_long_term_memory WHERE user_id = ? AND tenant_id = ? ORDER BY updated_at DESC LIMIT 1",
    [user.userId, user.tenantId]
  );
  if (!rows || rows.length === 0) return "";
  return rows[0].memory_summary || "";
}

export async function getRecentQAPairs({ convId, user }) {
  let recentQAPairsText = "";
  try {
    const priorMessages = await coreQuery(
      "SELECT role, content FROM messages WHERE conversation_id = ? AND tenant_id = ? ORDER BY created_at ASC, id ASC",
      [convId, user.tenantId]
    );

    if (priorMessages.length > 0) priorMessages.pop();

    const qaPairs = extractLastQAPairs(priorMessages, 2);
    recentQAPairsText = formatRecentQAPairsForContext(qaPairs);
  } catch (qaErr) {
    console.error("Error building recent Q&A context:", qaErr);
  }
  return recentQAPairsText;
}

export async function retrieveRAGContext({ tenant, question, useRag, k = 5 }) {
  if (!useRag) {
    return {
      retrievedDocs: [],
      ragSourcesText: "",
      ragError: null,
    };
  }

  let retrievedDocs = [];
  let ragError = null;

  try {
    const qdrant = createQdrantHelper({
      collection: tenant.qdrant_collection,
    });

    const vectorStore = await qdrant.getVectorStore();
    retrievedDocs = await vectorStore.similaritySearch(question, k);
  } catch (err) {
    console.error("RAG retrieval error:", err);
    ragError = String(err?.message || err);
    retrievedDocs = [];
  }

  const ragSourcesText = retrievedDocs
    .map((d, idx) => {
      const meta = d.metadata || {};
      const labelParts = [];

      if (meta.type) labelParts.push(String(meta.type));
      if (meta.title) labelParts.push(String(meta.title));
      if (meta.table_name) labelParts.push(`table: ${meta.table_name}`);
      if (meta.column_name) labelParts.push(`column: ${meta.column_name}`);
      if (meta.filename) labelParts.push(`file: ${meta.filename}`);
      if (meta.page != null) labelParts.push(`page: ${meta.page}`);

      const header =
        labelParts.length > 0
          ? `Source #${idx + 1} [${labelParts.join(" · ")}]`
          : `Source #${idx + 1}`;

      return `${header}\n${d.pageContent}`;
    })
    .join("\n\n");

  return {
    retrievedDocs,
    ragSourcesText,
    ragError,
  };
}

export function buildCombinedContext({
  recentQAPairsText,
  userMemorySummary,
  conversationSummaryForPrompt,
  ragSourcesText,
}) {
  const contextParts = [];

  if (recentQAPairsText) {
    contextParts.push(
      "Most recent questions and answers (before the current question):\n" +
        recentQAPairsText
    );
  }

  if (userMemorySummary) {
    contextParts.push(
      "User long-term memory / preferences:\n" + userMemorySummary
    );
  }

  if (conversationSummaryForPrompt) {
    contextParts.push(
      "Conversation summary so far:\n" + conversationSummaryForPrompt
    );
  }

  if (ragSourcesText) {
    contextParts.push("Knowledge base sources:\n" + ragSourcesText);
  }

  return contextParts.length > 0
    ? contextParts.join("\n\n---\n\n")
    : "(No additional RAG or memory context available.)";
}
