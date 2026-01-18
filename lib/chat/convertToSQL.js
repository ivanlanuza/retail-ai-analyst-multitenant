// lib/chat/convertToSQL.js
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { runTenantScopedQuery } from "@/lib/db/runTenantScopedQuery";
import { coreQuery } from "@/lib/db/coreDb";

/* Convert a natural-language question into a SQL SELECT query. */
export async function convertToSQL({
  llm,
  question,
  schemaText,
  context,
  maxRows,
  dbType,
}) {
  const sqlPrompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      [
        `You are an SQL assistant for a ${dbType} database that stores retail data`,
        "You can ONLY generate a single SQL SELECT query.",
        "Never modify data (no INSERT, UPDATE, DELETE, DROP, CREATE, ALTER).",
        `Always use LIMIT ${maxRows} unless the user explicitly asks for a different limit.`,
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

  const messages = await sqlPrompt.formatMessages({
    schema: schemaText,
    context: context || "",
    question,
  });

  const sqlMsg = await llm.invoke(messages);
  const raw = String(sqlMsg.content || "").trim();

  const sql =
    raw
      .replace(/```sql/gi, "")
      .replace(/```/g, "")
      .trim() || raw;

  const usage = sqlMsg.usage_metadata || {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };

  return { sql, usage };
}

/* Execute a SQL query against the tenant's data database. */
export async function executeDataSQL({ tenant, sql }) {
  let rows = [];
  let fields = [];
  let executionError = null;

  const startedAt = Date.now();

  try {
    const result = await runTenantScopedQuery(tenant, sql);
    rows = result.rows;
    fields = result.fields || [];
    sql = result.sql; // scoped / rewritten SQL takes precedence
  } catch (err) {
    executionError = err;
  }

  const durationMs = Date.now() - startedAt;
  const rowCount = Array.isArray(rows) ? rows.length : 0;
  const status = executionError ? "error" : "success";
  const errorMessage = executionError
    ? String(executionError.message || executionError)
    : null;

  return {
    sql,
    rows,
    fields,
    rowCount,
    durationMs,
    status,
    executionError,
    errorMessage,
  };
}

// Persist final executed SQL metadata.
export async function logFinalSQL({
  tenantId,
  conversationId,
  messageId,
  finalSql,
  status,
  rowCount,
  errorMessage,
  durationMs,
}) {
  const result = await coreQuery(
    `INSERT INTO sql_queries
     (tenant_id, conversation_id, message_id, sql_text, status, rows_returned, error_message, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      conversationId,
      messageId,
      finalSql,
      status,
      rowCount,
      errorMessage,
      durationMs,
    ]
  );

  return result.insertId;
}
