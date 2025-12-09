// pages/api/chat/ask.js
import { query, queryWithFields } from "../../../lib/db";
import { getUserFromRequest } from "../../../lib/auth";
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { getSchemaText } from "../../../lib/sqlDb";

const MODEL_NAME = "gpt-4o-mini";

const llm = new ChatOpenAI({
  model: MODEL_NAME,
  temperature: 0,
});

/**
 * Safely convert ChatOpenAI message content to a string
 */
function contentToString(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part.text || ""))
      .join("");
  }
  if (typeof content === "object" && content !== null && "text" in content) {
    return content.text;
  }
  return String(content ?? "");
}

/**
 * Derive a conversation title from the first question
 */
function deriveConversationTitle(question) {
  const trimmed = question.trim();
  if (!trimmed) return "New conversation";
  return trimmed.length > 80 ? trimmed.slice(0, 77) + "..." : trimmed;
}

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

  try {
    let convId = conversationId || null;

    // 1) Ensure conversation exists or create a new one
    if (!convId) {
      const title = deriveConversationTitle(question);
      const convResult = await query(
        "INSERT INTO conversations (user_id, title) VALUES (?, ?)",
        [user.id, title]
      );
      convId = convResult.insertId;
    } else {
      // Make sure it belongs to the current user
      const existing = await query(
        "SELECT id FROM conversations WHERE id = ? AND user_id = ?",
        [convId, user.id]
      );
      if (existing.length === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }
    }

    // 2) Insert user message
    const userMsgResult = await query(
      "INSERT INTO messages (conversation_id, user_id, role, content) VALUES (?, ?, ?, ?)",
      [convId, user.id, "user", question.trim()]
    );
    const userMessageId = userMsgResult.insertId;

    // 3) Build NL -> SQL prompt using schema introspection
    const schemaText = await getSchemaText();

    const sqlPrompt = ChatPromptTemplate.fromMessages([
      [
        "system",
        [
          "You are a SQL assistant for a MySQL 8 database that stores loyalty metrics.",
          "You can ONLY generate a single SQL SELECT query.",
          "Never modify data (no INSERT, UPDATE, DELETE, DROP, CREATE, ALTER).",
          "All amounts are in Philippine Pesos (PHP).",
          "Always use LIMIT 500 unless the user explicitly asks for a different limit.",
          "If they ask for 'top N', use ORDER BY on a relevant column and LIMIT N.",
          "Use the following database schema:",
          "",
          "{schema}",
          "",
          "Return ONLY the SQL query, nothing else.",
        ].join("\n"),
      ],
      [
        "human",
        "User question:\n{question}\n\nRemember: return only valid MySQL SQL.",
      ],
    ]);

    const sqlMessages = await sqlPrompt.formatMessages({
      schema: schemaText,
      question,
    });

    const sqlMsg = await llm.invoke(sqlMessages);
    const sqlRaw = contentToString(sqlMsg.content).trim();

    const sql =
      sqlRaw
        .replace(/```sql/gi, "")
        .replace(/```/g, "")
        .trim() || sqlRaw;

    const sqlUsage = sqlMsg.usage_metadata || {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    };

    // 4) Execute SQL
    let rows = [];
    let fields = [];
    let executionError = null;
    const startedAt = Date.now();

    try {
      const result = await queryWithFields(sql);
      rows = result.rows;
      fields = result.fields || [];
    } catch (err) {
      executionError = err;
    }

    const durationMs = Date.now() - startedAt;
    const rowCount = Array.isArray(rows) ? rows.length : 0;
    const status = executionError ? "error" : "success";
    const errorMessage = executionError
      ? String(executionError.message || executionError)
      : null;

    // 5) Log SQL query
    const sqlQueryResult = await query(
      `INSERT INTO sql_queries
       (conversation_id, message_id, user_id, sql_text, status, rows_returned, error_message, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        convId,
        userMessageId,
        user.id,
        sql,
        status,
        rowCount,
        errorMessage,
        durationMs,
      ]
    );
    const sqlQueryId = sqlQueryResult.insertId;

    if (executionError) {
      // For Phase 1: return SQL + error so you can debug prompt/chain
      return res.status(400).json({
        error: "SQL_EXECUTION_ERROR",
        message: errorMessage,
        sql,
        conversationId: convId,
      });
    }

    // 6) Generate short text answer based on rows
    const sampleRows = rows.slice(0, 20);

    const answerPrompt = ChatPromptTemplate.fromMessages([
      [
        "system",
        [
          "You are a data analyst.",
          "Given the user's question, the SQL query that was run, and the resulting rows,",
          "produce a short, clear answer (1–3 sentences) in plain English.",
        ].join(" "),
      ],
      [
        "human",
        [
          "User question:",
          "{question}",
          "",
          "SQL executed:",
          "{sql}",
          "",
          "First rows (JSON):",
          "{rowsJson}",
          "",
          "Now write a short answer for the user. Do NOT repeat the SQL.",
        ].join("\n"),
      ],
    ]);

    const answerMessages = await answerPrompt.formatMessages({
      question,
      sql,
      rowsJson: JSON.stringify(sampleRows),
    });

    const answerMsg = await llm.invoke(answerMessages);
    const answerText = contentToString(answerMsg.content).trim();

    const answerUsage = answerMsg.usage_metadata || {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    };

    const totalInputTokens =
      (sqlUsage.input_tokens || 0) + (answerUsage.input_tokens || 0);
    const totalOutputTokens =
      (sqlUsage.output_tokens || 0) + (answerUsage.output_tokens || 0);
    const totalTokens =
      (sqlUsage.total_tokens || 0) + (answerUsage.total_tokens || 0);

    // 7) Store assistant message
    const assistantMsgResult = await query(
      "INSERT INTO messages (conversation_id, user_id, role, content) VALUES (?, ?, ?, ?)",
      [convId, null, "assistant", answerText]
    );
    const assistantMessageId = assistantMsgResult.insertId;

    // 8) Store token usage
    await query(
      `INSERT INTO token_usage
       (conversation_id, message_id, user_id, model, prompt_tokens, completion_tokens, total_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        convId,
        assistantMessageId,
        user.id,
        MODEL_NAME,
        totalInputTokens,
        totalOutputTokens,
        totalTokens,
      ]
    );

    // 9) Fetch full conversation messages for the frontend (optional but keeps existing UX)
    const messages = await query(
      "SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
      [convId]
    );

    const columns = fields.map((f) => f.name);

    return res.status(200).json({
      conversationId: convId,
      messages,
      status: "complete",
      answer: answerText,
      sql,
      table: {
        columns,
        rows,
      },
      tokens: {
        model: MODEL_NAME,
        input: totalInputTokens,
        output: totalOutputTokens,
        total: totalTokens,
      },
      sqlQueryId,
    });
  } catch (err) {
    console.error("Error in /api/chat/ask:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
