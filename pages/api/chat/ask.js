// pages/api/chat/ask.js
import { query, queryWithFields } from "../../../lib/db.mjs";
import { getUserFromRequest } from "../../../lib/auth";
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { getSchemaText } from "../../../lib/sqlDb";
import { getVectorStore } from "../../../lib/qdrantStore"; // <-- RAG
import { z } from "zod";
import Papa from "papaparse";

const MODEL_NAME = "gpt-4o-mini";

const llm = new ChatOpenAI({
  model: MODEL_NAME,
  temperature: 0,
});

const SUMMARY_MESSAGE_INTERVAL = 12; // summarize every 12 messages
const MIN_MESSAGES_FOR_SUMMARY = 6; // minimum before summarizing

// ===== Phase 4: AnswerPayload + CSV export =====
const MAX_TABLE_ROWS_IN_RESPONSE = 20; // must match prompt rule unless user asks otherwise
const CSV_EXPORT_ROW_THRESHOLD = 100; // when >= this, include csv export payload

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

function safeJsonParse(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // strip common fenced blocks
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
 * Classify whether the user is asking for data (something that should hit the DB)
 * vs. a general/non-data request.
 * Returns true if it's likely a data question, false otherwise.
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
  // Fallback: be permissive and treat as data question so we don't block valid use
  return true;
}

/**
 * Build a friendly, contextual response for non-data questions.
 * It should acknowledge what the user said, but gently steer them
 * toward asking a data / analytics question instead.
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
    // Fallback static text if the LLM somehow returns empty content
    return (
      'Got it. This assistant is wired to answer questions by querying your data (for example: "Show me sales by store for last month" or "Compare loyalty signups by branch"). ' +
      "If you’d like, ask what you want to see in the data and I’ll run the query for you."
    );
  }
  return text;
}

/**
 * Extract the last N question/answer pairs from a chronological message list.
 * A pair is user (question) followed by assistant (answer).
 */
function extractLastQAPairs(messages, maxPairs = 2) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  // messages are expected to be in chronological order
  const pairs = [];
  let currentPair = null;

  for (const m of messages) {
    if (m.role === "user") {
      // start a new pair for each user message
      currentPair = { question: m.content || "", answer: null };
      pairs.push(currentPair);
      // keep only the last maxPairs
      if (pairs.length > maxPairs) {
        pairs.shift();
      }
    } else if (m.role === "assistant") {
      // attach assistant reply to the most recent pair without an answer
      if (pairs.length > 0) {
        const last = pairs[pairs.length - 1];
        if (last && !last.answer) {
          last.answer = m.content || "";
        }
      }
    }
  }

  return pairs;
}

/**
 * Format recent Q&A pairs into a short context string for the LLM.
 */
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

/**
 * Format messages into a plain-text transcript for summarization.
 */
function formatMessagesForSummary(messages) {
  return messages
    .map((m) => {
      const role = m.role ? m.role.toUpperCase() : "UNKNOWN";
      return `${role}: ${m.content}`;
    })
    .join("\n\n");
}

/**
 * Maybe update the conversation_summary for a conversation.
 * - Only runs when messageCount >= MIN_MESSAGES_FOR_SUMMARY
 *   AND messageCount % SUMMARY_MESSAGE_INTERVAL === 0
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

/**
 * Fetch the latest long-term memory summary for a user, if any.
 */
async function getUserLongTermMemorySummary(userId) {
  const rows = await query(
    "SELECT memory_summary FROM user_long_term_memory WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1",
    [userId]
  );
  if (!rows || rows.length === 0) return "";
  return rows[0].memory_summary || "";
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
  // IMPORTANT: enable streaming immediately so all responses use SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  function emit(event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  function closeWith(event, payload, statusCode = 200) {
    res.statusCode = statusCode;
    emit(event, payload);
    res.end();
  }

  function streamError(statusCode, code, message, extra = {}) {
    closeWith("error", { code, message, ...extra }, statusCode);
  }

  if (req.method !== "POST") {
    streamError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return;
  }

  const user = await getUserFromRequest(req);
  if (!user) {
    streamError(401, "UNAUTHORIZED", "Unauthorized");
    return;
  }

  emit("status", { message: "Starting analysis…" });

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
        streamError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
        return;
      }
    }

    // 2) Insert user message
    const userMsgResult = await query(
      "INSERT INTO messages (conversation_id, user_id, role, content) VALUES (?, ?, ?, ?)",
      [convId, user.id, "user", question.trim()]
    );
    const userMessageId = userMsgResult.insertId;
    emit("status", { message: "Understanding your question…" });

    // 2.0) Quick classification: is this a data question?
    let isDataRequest = true;
    try {
      isDataRequest = await isDataQuestion(question);
    } catch (classErr) {
      console.error("Error classifying question as data/non-data:", classErr);
      // default: treat as data question so we don't block valid flows
      isDataRequest = true;
    }

    emit("status", {
      message: isDataRequest
        ? "Preparing to query your data…"
        : "Preparing response…",
    });

    if (!isDataRequest) {
      let acknowledgment;
      try {
        acknowledgment = await buildNonDataResponse(question);
      } catch (ndErr) {
        console.error("Error building non-data response:", ndErr);
        acknowledgment =
          'Got it. This assistant is wired to answer questions by querying your data (for example: "Show me sales by store for last month" or "Compare loyalty signups by branch"). ' +
          "If you’d like, ask what you want to see in the data and I’ll run the query for you.";
      }

      // Phase 4: answerPayload for non-data
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

      // Store assistant message so the conversation thread stays consistent
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

      // Optionally log token usage as zeroed for this non-data turn
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

      closeWith("final", {
        conversationId: convId,
        messages,
        answerPayload,
      });
      return;
    }

    emit("status", { message: "Gathering user context…" });

    // 2.1) Fetch existing conversation summary + user long-term memory for this request
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

    const userMemorySummary = await getUserLongTermMemorySummary(user.id);

    // 2.2) Compute recent Q&A pairs (before this question) for extra context
    let recentQAPairsText = "";
    try {
      const priorMessages = await query(
        "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
        [convId]
      );

      // Remove the last message (the current question we just inserted)
      if (priorMessages.length > 0) {
        priorMessages.pop();
      }

      const qaPairs = extractLastQAPairs(priorMessages, 2);
      recentQAPairsText = formatRecentQAPairsForContext(qaPairs);
    } catch (qaErr) {
      console.error("Error building recent Q&A context:", qaErr);
    }

    emit("status", { message: "Getting Business Context..." });
    // 3) RAG: retrieve context from vector DB (optional)
    let retrievedDocs = [];
    let ragError = null;

    if (useRagBool) {
      try {
        const vectorStore = await getVectorStore();
        // tweak k / filters as needed
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

    // Build a combined "context" string that includes:
    // - User long-term memory
    // - Conversation summary
    // - RAG knowledge base snippets
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

    emit("status", { message: "Generating SQL query…" });
    // 4) Build NL -> SQL prompt using schema introspection + memory + RAG context
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

    emit("status", { message: "Running query on database…" });
    // 5) Execute SQL
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

    // 6) Log SQL query
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

    emit("status", { message: "Summarizing results…" });
    // 7) Generate short text answer based on rows
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

    const totalInputTokens =
      (sqlUsage.input_tokens || 0) + (answerUsage.input_tokens || 0);
    const totalOutputTokens =
      (sqlUsage.output_tokens || 0) + (answerUsage.output_tokens || 0);
    const totalTokens =
      (sqlUsage.total_tokens || 0) + (answerUsage.total_tokens || 0);

    // 8) Telemetry: log query, answer, and RAG sources
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
          // Build a multi-row INSERT with explicit placeholders because our
          // db helper uses `execute`, which does not expand `VALUES ?`.
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

    const columns = fields.map((f) => f.name);

    // Phase 4: table + export handling
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

    // 9) Store assistant message
    const assistantMsgResult = await query(
      `INSERT INTO messages
   (conversation_id, user_id, role, content, answer_payload)
   VALUES (?, ?, ?, ?, ?)`,
      [convId, null, "assistant", answerText, JSON.stringify(answerPayload)]
    );
    const assistantMessageId = assistantMsgResult.insertId;

    // 10) Store token usage
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

    // 11) Fetch full conversation messages for the frontend
    const messages = await query(
      "SELECT id, role, content, answer_payload, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
      [convId]
    );

    // 11.1) Maybe update conversation summary (for future turns)
    try {
      await maybeUpdateConversationSummary(
        convId,
        messages,
        conversationSummaryForPrompt
      );
    } catch (summaryErr) {
      console.error("Error updating conversation summary:", summaryErr);
    }

    // Best-effort validation; do not crash the request if schema mismatches
    try {
      AnswerPayloadSchema.parse(answerPayload);
    } catch (apErr) {
      console.error("AnswerPayload validation failed (non-fatal):", apErr);
    }

    //console.log(answerPayload);

    closeWith("final", {
      conversationId: convId,
      messages,
      answerPayload,
    });

    /*
    return res.status(200).json({
      answerPayload,
      conversationId: convId,
      messages,
      status: "complete",
      answer: answerText,
      sql,
      table: {
        columns,
        rows: tableRowsForUi,
      },
      tokens: {
        model: MODEL_NAME,
        input: totalInputTokens,
        output: totalOutputTokens,
        total: totalTokens,
      },
      sqlQueryId,
      rag: {
        requested: useRagBool,
        used: useRagBool && retrievedDocs.length > 0,
        error: ragError,
        sourceCount: ragSources.length,
        sources: ragSources,
      },
    });*/
  } catch (err) {
    console.error("Error in /api/chat/ask:", err);
    if (!res.writableEnded) {
      streamError(500, "INTERNAL_SERVER_ERROR", "Internal server error");
    }
  }
}
