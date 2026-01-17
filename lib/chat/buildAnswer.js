import { ChatPromptTemplate } from "@langchain/core/prompts";
import { coreQuery } from "@/lib/db/coreDb";
import { contentToString } from "./contentToString";
import Papa from "papaparse";

const SUMMARY_MESSAGE_INTERVAL = 12;
const MIN_MESSAGES_FOR_SUMMARY = 2;

function emptyUsage() {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

//Safely parse JSON from LLM output.
function safeJsonParse(text) {
  if (!text || typeof text !== "string") return null;

  const cleaned = text
    .trim()
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

//Format messages for summary generation.
function formatMessagesForSummary(messages) {
  return messages
    .map((m) => {
      const role = m.role ? String(m.role).toUpperCase() : "UNKNOWN";
      return `${role}: ${m.content}`;
    })
    .join("\n\n");
}

//Maybe update conversation summary based on message count.
async function maybeUpdateConversationSummary(
  convId,
  messages,
  existingSummary = "",
  llm
) {
  const messageCount = Array.isArray(messages) ? messages.length : 0;

  if (
    messageCount < MIN_MESSAGES_FOR_SUMMARY ||
    messageCount % SUMMARY_MESSAGE_INTERVAL !== 0
  ) {
    return { updatedSummary: null, usage: emptyUsage() };
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
  const usage = summaryMsg.usage_metadata || emptyUsage();
  if (!updatedSummary) return { updatedSummary: null, usage };

  await coreQuery(
    "UPDATE conversations SET conversation_summary = ?, summary_updated_at = NOW() WHERE id = ?",
    [updatedSummary, convId]
  );

  return { updatedSummary, usage };
}

//Generate a concise natural-language answer from query results.
export async function getAnswerText({ llm, question, sql, fields, rows }) {
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

  const messages = await answerPrompt.formatMessages({
    question,
    sql,
    columnsJson: JSON.stringify(fields.map((f) => f.name)),
    rowsJson: JSON.stringify(sampleRows),
  });

  const answerMsg = await llm.invoke(messages);
  const rawText = contentToString(answerMsg.content);

  const parsed = safeJsonParse(rawText);

  let answerText = "";
  if (parsed && typeof parsed === "object") {
    answerText = String(parsed.answerText || "").trim();
  }

  if (!answerText) {
    // Fallback to raw model output
    answerText = rawText.trim();
  }

  const usage = answerMsg.usage_metadata || {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };

  return {
    answerText,
    usage,
  };
}

// Persist telemetry for a completed answer.  Query_logs and query_sources (for RAG).
export async function logAnswerTelemetry({
  tenantId,
  userId,
  conversationId,
  question,
  answerText,
  sql,
  usage,
  durationMs,
  modelName,
  useRagBool,
  retrievedDocs,
}) {
  const usedRagFlag = useRagBool && retrievedDocs.length > 0;

  const answerSummary =
    answerText && answerText.length > 500
      ? answerText.slice(0, 497) + "..."
      : answerText || null;

  let queryLogId = null;

  try {
    const result = await coreQuery(
      `INSERT INTO query_logs
       (tenant_id, user_id, conversation_id, question, answer_summary, sql_query, used_rag, model,
        prompt_tokens, completion_tokens, total_tokens, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId,
        userId,
        conversationId,
        question.trim(),
        answerSummary,
        sql,
        usedRagFlag ? 1 : 0,
        modelName,
        usage.input_tokens,
        usage.output_tokens,
        usage.total_tokens,
        durationMs,
      ]
    );

    queryLogId = result.insertId;
  } catch (err) {
    console.error("Error inserting into query_logs:", err);
    return null;
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
        const placeholders = values.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
        const flatParams = values.flat();

        await coreQuery(
          `INSERT INTO query_sources
           (query_log_id, source_type, title, table_name, similarity_score, source_rank)
           VALUES ${placeholders}`,
          flatParams
        );
      }
    } catch (err) {
      console.error("Error inserting into query_sources:", err);
    }
  }

  return queryLogId;
}

//Build table payload + optional CSV downloads
export function buildTable({ fields, rows, convId, maxRows, csvThreshold }) {
  const columns = fields.map((f) => f.name);

  const fullRowCount = Array.isArray(rows) ? rows.length : 0;
  const truncated = fullRowCount > maxRows;

  const tableRows = truncated ? rows.slice(0, maxRows) : rows;

  const downloads = [];

  try {
    if (fullRowCount >= csvThreshold && Array.isArray(rows)) {
      const csv = Papa.unparse(rows, { skipEmptyLines: true });
      downloads.push({
        kind: "csv",
        filename: `export-${convId}-${Date.now()}.csv`,
        mimeType: "text/csv",
        content: csv,
      });
    }
  } catch (err) {
    console.error("CSV export build error:", err);
  }

  return {
    table: {
      columns,
      rows: tableRows,
      rowCount: fullRowCount,
      truncated,
    },
    downloads,
  };
}

//Shape RAG metadata for frontend consumption
export function buildRagMeta({ requested, retrievedDocs, ragError }) {
  const sources = (retrievedDocs || []).map((d, idx) => {
    const meta = d.metadata || {};
    return {
      id: idx + 1,
      type: meta.type || null,
      title:
        meta.title || meta.table_name || meta.filename || `Source #${idx + 1}`,
      table_name: meta.table_name || null,
      column_name: meta.column_name || null,
      page: meta.page != null ? meta.page : null,
      filename: meta.filename || null,
      source: meta.source || null,
      snippet: d.pageContent ? String(d.pageContent).slice(0, 500) : null,
    };
  });

  return {
    requested: Boolean(requested),
    used: requested && sources.length > 0,
    error: ragError || null,
    sourceCount: sources.length,
    sources,
  };
}

//Build the final UI answer payload
export function buildAnswerPayload({
  answerText,
  sql,
  sqlQueryId,
  usage,
  modelName,
  table,
  downloads,
  chart,
  rag,
}) {
  return {
    version: "v1",
    status: "complete",
    answerText,
    table,
    downloads,
    chart,
    meta: {
      sql,
      sqlQueryId,
      tokens: {
        model: modelName,
        input: usage.input_tokens,
        output: usage.output_tokens,
        total: usage.total_tokens,
      },
      rag,
    },
  };
}

//Persist assistant message to DB
export async function persistAssistantMessage({
  tenantId,
  userId,
  conversationId,
  answerText,
  answerPayload,
  modelName,
  usage,
}) {
  const result = await coreQuery(
    `INSERT INTO messages
     (tenant_id, conversation_id, role, content, answer_payload)
     VALUES (?, ?, 'assistant', ?, ?)`,
    [tenantId, conversationId, answerText, JSON.stringify(answerPayload)]
  );

  const token_usage = await coreQuery(
    `INSERT INTO token_usage
     (tenant_id, conversation_id, message_id, user_id, model,
      prompt_tokens, completion_tokens, total_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      conversationId,
      result.insertId,
      userId,
      modelName,
      usage.input_tokens,
      usage.output_tokens,
      usage.total_tokens,
    ]
  );

  return { messageId: result.insertId, tokenUsageId: token_usage.insertId };
}

//Persist assistant message to DB
export async function updateMessageSummary({
  convId,
  conversationSummaryForPrompt,
  user,
  llm,
}) {
  const messages = await coreQuery(
    "SELECT id, role, content, answer_payload, created_at FROM messages WHERE conversation_id = ? AND tenant_id = ? ORDER BY created_at ASC, id ASC",
    [convId, user.tenantId]
  );

  let usage = emptyUsage();
  try {
    const result = await maybeUpdateConversationSummary(
      convId,
      messages,
      conversationSummaryForPrompt,
      llm
    );
    usage = result?.usage || emptyUsage();
  } catch (summaryErr) {
    console.error("Error updating conversation summary:", summaryErr);
  }

  return { messages, usage };
}
