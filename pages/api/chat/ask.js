// pages/api/chat/ask.js
// Streaming (SSE) chat endpoint: classifies request, optionally retrieves context (RAG/memory),
// generates SQL, runs it, summarizes results, and returns a stable `answerPayload` for the UI.

import { query, queryWithFields } from "../../../lib/db.mjs";
import { getUserFromRequest } from "../../../lib/auth";
import { getSchemaText } from "../../../lib/sqlDb";
import { getVectorStore } from "../../../lib/qdrantStore"; // RAG

import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import Papa from "papaparse";

// -----------------------------
// Model + behavior constants
// -----------------------------

const MODEL_NAME = "gpt-4o-mini";
const llm = new ChatOpenAI({ model: MODEL_NAME, temperature: 0 });

const SUMMARY_MESSAGE_INTERVAL = 12; // summarize every 12 messages
const MIN_MESSAGES_FOR_SUMMARY = 6; // minimum before summarizing

// UI contract: these must match the prompt rules / frontend expectations
const MAX_TABLE_ROWS_IN_RESPONSE = 20; // must match prompt rule unless user asks otherwise
const CSV_EXPORT_ROW_THRESHOLD = 21; // when >= this, include csv export payload

// -----------------------------
// Schemas (best-effort validation)
// -----------------------------

const TableSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.any()),
  rowCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const DownloadSchema = z
  .object({
    kind: z.literal("csv"),
    filename: z.string(),
    mimeType: z.literal("text/csv"),
    content: z.string(), // raw CSV string
  })
  .passthrough();

const AnswerPayloadSchema = z
  .object({
    version: z.literal("v1"),
    status: z.enum(["complete", "non_data", "error"]),
    answerText: z.string(),
    table: TableSchema.optional().nullable(),
    downloads: z.array(DownloadSchema).optional().nullable(),
    meta: z
      .object({
        sql: z.string().optional().nullable(),
        sqlQueryId: z.number().int().optional().nullable(),
        tokens: z
          .object({
            model: z.string(),
            input: z.number(),
            output: z.number(),
            total: z.number(),
          })
          .optional()
          .nullable(),
        rag: z
          .object({
            requested: z.boolean(),
            used: z.boolean(),
            error: z.string().nullable(),
            sourceCount: z.number().int().nonnegative(),
            sources: z.array(z.any()),
          })
          .optional()
          .nullable(),
      })
      .optional()
      .nullable(),
  })
  .passthrough();

// -----------------------------
// Small utilities
// -----------------------------

function safeJsonParse(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Strip common fenced blocks
  const cleaned = trimmed
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * Convert LangChain message content to a string.
 */
function contentToString(content) {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("");
  }

  if (typeof content === "object" && content !== null && "text" in content) {
    return content.text;
  }

  return String(content ?? "");
}

// -----------------------------
// Non-data classification and response
// -----------------------------

/**
 * Decide if a question should hit the database.
 * Returns true for likely-data questions, false for non-data questions.
 */
async function isDataQuestion(question) {
  const classifyPrompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      [
        "You are a classifier in a retail analytics assistant.",
        "Your job is to decide if the user is asking for DATA from the database",
        "(for example: metrics, counts, lists, breakdowns, comparisons, trends, or reports)",
        "or if they are instead asking for something else (like how the system works, general advice, or small talk).",
        "note that question might be in reference to previous question/answers in the conversation. for example: 'can you add transaction count to that and remove gender?' - this is valid because it wants data too.",
        "",
        "If the question requires querying or calculating from stored business data, answer exactly: YES",
        "If not, answer exactly: NO",
        "",
        "Do not add any other words.",
      ].join(" "),
    ],
    ["human", "User question:\n{question}\n\nAnswer with only YES or NO."],
  ]);

  const messages = await classifyPrompt.formatMessages({ question });
  const resp = await llm.invoke(messages);
  const text = contentToString(resp.content).trim().toUpperCase();

  if (text.startsWith("YES")) return true;
  if (text.startsWith("NO")) return false;

  // Fallback: be permissive so we don't block valid use
  return true;
}

/**
 * Friendly response for non-data questions.
 */
async function buildNonDataResponse(question) {
  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      [
        "You are the assistant for a retail analytics tool that answers questions by querying business data (via SQL).",
        "This tool is specifically for understanding the customer loyalty information stored in the database.",
        "Sometimes users send messages that are not actually data questions (e.g., small talk, how-the-system-works questions, meta questions, or vague comments).",
        "",
        "Your job is to:",
        "- Respond in a friendly, concise way (1–3 sentences).",
        "- Acknowledge the content or intent of the user's message.",
        "- Clearly but gently remind them that this assistant is best used for questions about their data (metrics, reports, comparisons, trends, etc.).",
        "- Invite them to ask a concrete data question (you can give 1–2 example phrasings).",
        "",
        "Do NOT generate or mention any SQL in your reply.",
        "Do NOT say you cannot answer; instead, explain how they can get value by asking about their data.",
      ].join(" "),
    ],
    [
      "human",
      "Here is the user's latest message:\n\n{question}\n\nWrite your friendly reply now.",
    ],
  ]);

  const messages = await prompt.formatMessages({ question });
  const resp = await llm.invoke(messages);
  const text = contentToString(resp.content).trim();

  if (!text) {
    // Hard fallback if the model returns empty
    return (
      'Got it. This assistant is wired to answer questions by querying your data (for example: "Show me sales by store for last month" or "Compare loyalty signups by branch"). ' +
      "If you’d like, ask what you want to see in the data and I’ll run the query for you."
    );
  }

  return text;
}

// -----------------------------
// Conversation context helpers
// -----------------------------

/**
 * Extract the last N question/answer pairs from a chronological message list.
 * A pair is user (question) followed by assistant (answer).
 */
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

function formatMessagesForSummary(messages) {
  return messages
    .map((m) => {
      const role = m.role ? String(m.role).toUpperCase() : "UNKNOWN";
      return `${role}: ${m.content}`;
    })
    .join("\n\n");
}

/**
 * Update conversation_summary on a cadence.
 */
async function maybeUpdateConversationSummary(
  convId,
  messages,
  existingSummary = ""
) {
  const messageCount = Array.isArray(messages) ? messages.length : 0;

  if (
    messageCount < MIN_MESSAGES_FOR_SUMMARY ||
    messageCount % SUMMARY_MESSAGE_INTERVAL !== 0
  ) {
    return null;
  }

  const transcript = formatMessagesForSummary(messages);

  const summaryPrompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      [
        "You maintain a running summary of a conversation between a retail executive and a data assistant.",
        "You are given the existing summary (which may be empty) and the full transcript of messages.",
        "Update the summary to capture the main goals, questions, decisions, constraints, and user preferences.",
        "Keep the summary concise (max 300 words) and focused on information that will be useful for future questions.",
        "Return only the updated summary text.",
      ].join(" "),
    ],
    [
      "human",
      [
        "Existing summary (may be empty):",
        "{existingSummary}",
        "",
        "Full conversation transcript:",
        "{transcript}",
        "",
        "Write an updated summary now.",
      ].join("\n"),
    ],
  ]);

  const summaryMessages = await summaryPrompt.formatMessages({
    existingSummary: existingSummary || "",
    transcript,
  });

  const summaryMsg = await llm.invoke(summaryMessages);
  const updatedSummary = contentToString(summaryMsg.content).trim();
  if (!updatedSummary) return null;

  await query(
    "UPDATE conversations SET conversation_summary = ?, summary_updated_at = NOW() WHERE id = ?",
    [updatedSummary, convId]
  );

  return updatedSummary;
}

async function getUserLongTermMemorySummary(userId) {
  const rows = await query(
    "SELECT memory_summary FROM user_long_term_memory WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1",
    [userId]
  );
  if (!rows || rows.length === 0) return "";
  return rows[0].memory_summary || "";
}

function deriveConversationTitle(question) {
  const trimmed = String(question || "").trim();
  if (!trimmed) return "New conversation";
  return trimmed.length > 80 ? trimmed.slice(0, 77) + "..." : trimmed;
}

// -----------------------------
// Main handler
// -----------------------------

export default async function handler(req, res) {
  // Enable SSE immediately: all responses are streamed as events
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // SSE helpers
  function emit(event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  function clampPercent(raw) {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, n));
  }

  function emitProgress(progress) {
    const pct = clampPercent(progress);
    if (pct == null) return;
    emit("progress", { progress: pct });
  }

  function emitStatus(message, progress = null) {
    const payload = { message };

    const pct = progress == null ? null : clampPercent(progress);
    if (pct != null) {
      payload.progress = pct;
    }

    emit("status", payload);

    // Also emit a dedicated progress event for UIs that prefer it.
    if (pct != null) {
      emitProgress(pct);
    }
  }

  function closeWith(event, payload, statusCode = 200) {
    res.statusCode = statusCode;
    emit(event, payload);
    res.end();
  }

  function streamError(statusCode, code, message, extra = {}) {
    closeWith("error", { code, message, ...extra }, statusCode);
  }

  // Request validation
  if (req.method !== "POST") {
    streamError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return;
  }

  const user = await getUserFromRequest(req);
  if (!user) {
    streamError(401, "UNAUTHORIZED", "Unauthorized");
    return;
  }

  emitStatus("Starting analysis…", 2);

  const { conversationId, question, useRag } =
    req.method === "POST" ? req.body : req.query;

  const useRagBool = useRag === "1" || useRag === true;

  if (
    !question ||
    typeof question !== "string" ||
    question.trim().length === 0
  ) {
    streamError(400, "INVALID_REQUEST", "Question is required");
    return;
  }

  try {
    // ---------------------------------
    // 1) Ensure conversation exists
    // ---------------------------------

    let convId = conversationId || null;

    if (!convId) {
      const title = deriveConversationTitle(question);
      const convResult = await query(
        "INSERT INTO conversations (user_id, title) VALUES (?, ?)",
        [user.id, title]
      );
      convId = convResult.insertId;
    } else {
      // Ensure the conversation belongs to this user
      const existing = await query(
        "SELECT id FROM conversations WHERE id = ? AND user_id = ?",
        [convId, user.id]
      );
      if (existing.length === 0) {
        streamError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
        return;
      }
    }

    // ---------------------------------
    // 2) Persist user message
    // ---------------------------------

    const userMsgResult = await query(
      "INSERT INTO messages (conversation_id, user_id, role, content) VALUES (?, ?, ?, ?)",
      [convId, user.id, "user", question.trim()]
    );

    const userMessageId = userMsgResult.insertId;
    emitStatus("Understanding your question…", 8);

    // ---------------------------------
    // 3) Quick classification: data vs non-data
    // ---------------------------------

    let isDataRequest = true;
    try {
      isDataRequest = await isDataQuestion(question);
    } catch (classErr) {
      console.error("Error classifying question as data/non-data:", classErr);
      isDataRequest = true; // permissive fallback
    }

    emitStatus(
      isDataRequest ? "Preparing to query your data…" : "Preparing response…",
      isDataRequest ? 15 : 20
    );

    // ---------------------------------
    // 4) Non-data path (no DB query)
    // ---------------------------------

    if (!isDataRequest) {
      let acknowledgment;
      try {
        emitStatus("Drafting response…", 60);
        acknowledgment = await buildNonDataResponse(question);
      } catch (ndErr) {
        console.error("Error building non-data response:", ndErr);
        acknowledgment =
          'Got it. This assistant is wired to answer questions by querying your data (for example: "Show me sales by store for last month" or "Compare loyalty signups by branch"). ' +
          "If you’d like, ask what you want to see in the data and I’ll run the query for you.";
      }

      // UI contract: stable answerPayload shape
      const answerPayload = {
        version: "v1",
        status: "non_data",
        answerText: acknowledgment,
        table: {
          columns: [],
          rows: [],
          rowCount: 0,
          truncated: false,
        },
        downloads: [],
        meta: {
          sql: null,
          sqlQueryId: null,
          tokens: {
            model: MODEL_NAME,
            input: 0,
            output: 0,
            total: 0,
          },
          rag: {
            requested: false,
            used: false,
            error: null,
            sourceCount: 0,
            sources: [],
          },
        },
      };

      emitStatus("Finalizing response…", 90);
      // Store assistant message
      const assistantMsgResult = await query(
        `INSERT INTO messages
   (conversation_id, user_id, role, content, answer_payload)
   VALUES (?, ?, ?, ?, ?)`,
        [
          convId,
          null,
          "assistant",
          acknowledgment,
          JSON.stringify(answerPayload),
        ]
      );

      const assistantMessageId = assistantMsgResult.insertId;

      // Token usage: explicitly log zeroed usage for non-data turn
      await query(
        `INSERT INTO token_usage
         (conversation_id, message_id, user_id, model, prompt_tokens, completion_tokens, total_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [convId, assistantMessageId, user.id, MODEL_NAME, 0, 0, 0]
      );

      const messages = await query(
        "SELECT id, role, content, answer_payload, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
        [convId]
      );

      emitStatus("Done.", 100);
      closeWith("final", {
        conversationId: convId,
        messages,
        answerPayload,
      });

      return;
    }

    // ---------------------------------
    // 5) Data path: gather context
    // ---------------------------------

    emitStatus("Gathering user context…", 25);

    // 5.1 conversation summary
    let conversationSummaryForPrompt = "";
    try {
      const convRows = await query(
        "SELECT conversation_summary FROM conversations WHERE id = ?",
        [convId]
      );
      if (convRows.length > 0) {
        conversationSummaryForPrompt = convRows[0].conversation_summary || "";
      }
    } catch (csErr) {
      console.error("Error fetching conversation summary:", csErr);
    }

    // 5.2 user long-term memory
    const userMemorySummary = await getUserLongTermMemorySummary(user.id);

    // 5.3 recent Q&A (excluding the current user question we just inserted)
    let recentQAPairsText = "";
    try {
      const priorMessages = await query(
        "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
        [convId]
      );

      if (priorMessages.length > 0) priorMessages.pop();

      const qaPairs = extractLastQAPairs(priorMessages, 2);
      recentQAPairsText = formatRecentQAPairsForContext(qaPairs);
    } catch (qaErr) {
      console.error("Error building recent Q&A context:", qaErr);
    }

    emitStatus("Getting Business Context...", 35);

    // 5.4 RAG context (optional)
    let retrievedDocs = [];
    let ragError = null;

    if (useRagBool) {
      try {
        const vectorStore = await getVectorStore();
        retrievedDocs = await vectorStore.similaritySearch(question, 5);
      } catch (err) {
        console.error("RAG retrieval error:", err);
        ragError = String(err?.message || err);
      }
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

    // Build combined context string
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

    const ragContext =
      contextParts.length > 0
        ? contextParts.join("\n\n---\n\n")
        : "(No additional RAG or memory context available.)";

    // ---------------------------------
    // 6) NL → SQL
    // ---------------------------------

    emitStatus("Generating SQL query…", 50);

    const schemaText = await getSchemaText();

    const sqlPrompt = ChatPromptTemplate.fromMessages([
      [
        "system",
        [
          "You are a SQL assistant for a MySQL 8 database that stores loyalty and retail metrics.",
          "You can ONLY generate a single SQL SELECT query.",
          "Never modify data (no INSERT, UPDATE, DELETE, DROP, CREATE, ALTER).",
          "All amounts are in Philippine Pesos (PHP).",
          `Always use LIMIT ${MAX_TABLE_ROWS_IN_RESPONSE} unless the user explicitly asks for a different limit.`,
          "If they ask for 'top N', use ORDER BY on a relevant column and LIMIT N.",
          "",
          "You have the following database schema:",
          "{schema}",
          "",
          "You also have additional context that may include:",
          "- User long-term preferences and environment.",
          "- A running summary of this conversation.",
          "- Knowledge base snippets from documentation or schema notes.",
          "",
          "{context}",
          "",
          "Use this context when it's relevant to interpret ambiguous column names, business terms, KPIs, or user intent,",
          "but do NOT invent tables or columns that are not present in the actual schema.",
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
      context: ragContext,
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

    // ---------------------------------
    // 7) Execute SQL
    // ---------------------------------

    emitStatus("Running query on database…", 65);

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

    // 7.1 Log SQL query execution
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
      streamError(
        400,
        "SQL_EXECUTION_ERROR",
        errorMessage || "SQL execution failed",
        {
          sql,
          conversationId: convId,
          rag: {
            requested: useRagBool,
            used: useRagBool && retrievedDocs.length > 0,
            error: ragError,
          },
        }
      );
      return;
    }

    // ---------------------------------
    // 8) Summarize results into answerText
    // ---------------------------------

    emitStatus("Summarizing results…", 80);

    const sampleRows = rows.slice(0, 50);

    const answerPrompt = ChatPromptTemplate.fromMessages([
      [
        "system",
        [
          "You are a data analyst.",
          "Given the user's question, the SQL query that was run, and the resulting rows,",
          "produce a short, clear answer (1–3 sentences) in plain English.",
          "For currency figures, always use Philippine Peso (₱).",
          "",
          "Return STRICT JSON ONLY with this shape:",
          "Use keys: answerText (string).",
          "",
          "Do NOT include SQL in the answerText.",
          "Do NOT include markdown fences.",
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
          "Columns:",
          "{columnsJson}",
          "",
          "First rows (JSON):",
          "{rowsJson}",
          "",
          "Now respond with strict JSON only.",
        ].join("\n"),
      ],
    ]);

    const answerMessages = await answerPrompt.formatMessages({
      question,
      sql,
      columnsJson: JSON.stringify(fields.map((f) => f.name)),
      rowsJson: JSON.stringify(sampleRows),
    });

    const answerMsg = await llm.invoke(answerMessages);
    const answerObj = safeJsonParse(contentToString(answerMsg.content));

    const answerUsage = answerMsg.usage_metadata || {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    };

    let answerText = "";
    if (answerObj && typeof answerObj === "object") {
      answerText = String(answerObj.answerText || "").trim();
    }

    if (!answerText) {
      // Fallback: preserve prior behavior if JSON parse fails
      answerText = contentToString(answerMsg.content).trim();
    }

    // Token totals across SQL + answer steps (UI contract)
    const totalInputTokens =
      (sqlUsage.input_tokens || 0) + (answerUsage.input_tokens || 0);
    const totalOutputTokens =
      (sqlUsage.output_tokens || 0) + (answerUsage.output_tokens || 0);
    const totalTokens =
      (sqlUsage.total_tokens || 0) + (answerUsage.total_tokens || 0);

    // ---------------------------------
    // 9) Telemetry: query_logs + sources
    // ---------------------------------

    const usedRagFlag = useRagBool && retrievedDocs.length > 0;
    const answerSummary =
      answerText && answerText.length > 500
        ? answerText.slice(0, 497) + "..."
        : answerText || null;

    let queryLogId = null;
    try {
      const queryLogResult = await query(
        `INSERT INTO query_logs
         (user_id, conversation_id, question, answer_summary, sql_query, used_rag, model,
          prompt_tokens, completion_tokens, total_tokens, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          user.id,
          convId,
          question.trim(),
          answerSummary,
          sql,
          usedRagFlag ? 1 : 0,
          MODEL_NAME,
          totalInputTokens,
          totalOutputTokens,
          totalTokens,
          durationMs,
        ]
      );
      queryLogId = queryLogResult.insertId;
    } catch (logErr) {
      console.error("Error inserting into query_logs:", logErr);
    }

    if (queryLogId && retrievedDocs.length > 0) {
      try {
        const values = retrievedDocs.map((d, idx) => {
          const meta = d.metadata || {};
          return [
            queryLogId,
            meta.type || null,
            meta.title ||
              meta.table_name ||
              meta.filename ||
              `Source #${idx + 1}`,
            meta.table_name || null,
            typeof d.score === "number" ? d.score : null,
            idx + 1,
          ];
        });

        if (values.length > 0) {
          // Our db helper uses `execute`, which does not expand `VALUES ?`,
          // so we build explicit placeholders.
          const placeholders = values
            .map(() => "(?, ?, ?, ?, ?, ?)")
            .join(", ");
          const flatParams = values.flat();

          await query(
            `INSERT INTO query_sources
             (query_log_id, source_type, title, table_name, similarity_score, source_rank)
             VALUES ${placeholders}`,
            flatParams
          );
        }
      } catch (srcErr) {
        console.error("Error inserting into query_sources:", srcErr);
      }
    }

    // ---------------------------------
    // 10) Build table + optional CSV download
    // ---------------------------------

    const columns = fields.map((f) => f.name);

    const fullRowCount = Array.isArray(rows) ? rows.length : 0;
    const tableTruncated = fullRowCount > MAX_TABLE_ROWS_IN_RESPONSE;
    const tableRowsForUi = tableTruncated
      ? rows.slice(0, MAX_TABLE_ROWS_IN_RESPONSE)
      : rows;

    const downloads = [];
    try {
      if (fullRowCount >= CSV_EXPORT_ROW_THRESHOLD && Array.isArray(rows)) {
        const csv = Papa.unparse(rows, { skipEmptyLines: true });
        downloads.push({
          kind: "csv",
          filename: `export-${convId}-${Date.now()}.csv`,
          mimeType: "text/csv",
          content: csv,
        });
      }
    } catch (csvErr) {
      console.error("CSV export build error:", csvErr);
    }

    // Shape RAG sources for frontend (for “Source materials” accordion)
    const ragSources = retrievedDocs.map((d, idx) => {
      const meta = d.metadata || {};
      return {
        id: idx + 1,
        type: meta.type || null,
        title:
          meta.title ||
          meta.table_name ||
          meta.filename ||
          `Source #${idx + 1}`,
        table_name: meta.table_name || null,
        column_name: meta.column_name || null,
        page: meta.page != null ? meta.page : null,
        filename: meta.filename || null,
        source: meta.source || null,
        snippet: d.pageContent ? String(d.pageContent).slice(0, 500) : null,
      };
    });

    // ---------------------------------
    // 11) Build answerPayload (UI contract)
    // ---------------------------------

    const answerPayload = {
      version: "v1",
      status: "complete",
      answerText,
      table: {
        columns,
        rows: tableRowsForUi,
        rowCount: fullRowCount,
        truncated: tableTruncated,
      },
      downloads,
      meta: {
        sql,
        sqlQueryId,
        tokens: {
          model: MODEL_NAME,
          input: totalInputTokens,
          output: totalOutputTokens,
          total: totalTokens,
        },
        rag: {
          requested: useRagBool,
          used: useRagBool && retrievedDocs.length > 0,
          error: ragError,
          sourceCount: ragSources.length,
          sources: ragSources,
        },
      },
    };

    emitStatus("Finalizing response…", 92);

    // ---------------------------------
    // 12) Persist assistant message + token usage
    // ---------------------------------

    const assistantMsgResult = await query(
      `INSERT INTO messages
   (conversation_id, user_id, role, content, answer_payload)
   VALUES (?, ?, ?, ?, ?)`,
      [convId, null, "assistant", answerText, JSON.stringify(answerPayload)]
    );

    const assistantMessageId = assistantMsgResult.insertId;

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

    // ---------------------------------
    // 13) Fetch updated messages + maybe update summary
    // ---------------------------------

    const messages = await query(
      "SELECT id, role, content, answer_payload, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
      [convId]
    );

    try {
      await maybeUpdateConversationSummary(
        convId,
        messages,
        conversationSummaryForPrompt
      );
    } catch (summaryErr) {
      console.error("Error updating conversation summary:", summaryErr);
    }

    // Best-effort validation; never fail the request on schema mismatches
    try {
      AnswerPayloadSchema.parse(answerPayload);
    } catch (apErr) {
      console.error("AnswerPayload validation failed (non-fatal):", apErr);
    }

    // ---------------------------------
    // 14) Final SSE response (UI contract)
    // ---------------------------------

    emitStatus("Done.", 100);
    closeWith("final", {
      conversationId: convId,
      messages,
      answerPayload,
    });
  } catch (err) {
    console.error("Error in /api/chat/ask:", err);
    if (!res.writableEnded) {
      streamError(500, "INTERNAL_SERVER_ERROR", "Internal server error");
    }
  }
}
