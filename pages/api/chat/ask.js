// pages/api/chat/ask.js
import { query, queryWithFields } from "../../../lib/db";
import { getUserFromRequest } from "../../../lib/auth";
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { getSchemaText } from "../../../lib/sqlDb";
import { getVectorStore } from "../../../lib/qdrantStore"; // <-- NEW (RAG)

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

  const { conversationId, question, useRag = true } = req.body || {};

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

    // 3) RAG: retrieve context from vector DB (optional)
    let retrievedDocs = [];
    let ragError = null;

    if (useRag) {
      try {
        const vectorStore = await getVectorStore();
        // tweak k / filters as needed
        retrievedDocs = await vectorStore.similaritySearch(question, 5);
      } catch (err) {
        console.error("RAG retrieval error:", err);
        ragError = String(err?.message || err);
      }
    }

    const ragContext = retrievedDocs
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

    // 4) Build NL -> SQL prompt using schema introspection + RAG context
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
          "",
          "You have the following database schema:",
          "{schema}",
          "",
          "You may also have additional business and schema context retrieved from a vector database:",
          "{context}",
          "",
          "Use the context when it's relevant to interpret ambiguous column names, business terms, or KPIs,",
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
      context: ragContext || "(No additional RAG context available.)",
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
      // For Phase 1/2: return SQL + error so you can debug prompt/chain
      return res.status(400).json({
        error: "SQL_EXECUTION_ERROR",
        message: errorMessage,
        sql,
        conversationId: convId,
        rag: {
          requested: !!useRag,
          used: !!useRag && retrievedDocs.length > 0,
          error: ragError,
        },
      });
    }

    // 7) Generate short text answer based on rows
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

    // 8) Telemetry: log query, answer, and RAG sources
    const usedRagFlag = !!useRag && retrievedDocs.length > 0;
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

    // 9) Store assistant message
    const assistantMsgResult = await query(
      "INSERT INTO messages (conversation_id, user_id, role, content) VALUES (?, ?, ?, ?)",
      [convId, null, "assistant", answerText]
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
      "SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
      [convId]
    );

    const columns = fields.map((f) => f.name);

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
      rag: {
        requested: !!useRag,
        used: !!useRag && retrievedDocs.length > 0,
        error: ragError,
        sourceCount: ragSources.length,
        sources: ragSources,
      },
    });
  } catch (err) {
    console.error("Error in /api/chat/ask:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
