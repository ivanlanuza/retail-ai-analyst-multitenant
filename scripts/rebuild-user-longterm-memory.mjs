// scripts/rebuild-user-longterm-memory.mjs
// Periodic job to rebuild user_long_term_memory from query_logs + conversations.
// To run, go to terminal and run directly: node scripts/rebuild-user-longterm-memory.mjs

import "dotenv/config";
import mysql from "mysql2/promise";
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";

const MODEL_NAME = process.env.OPENAI_MODEL || "gpt-4o-mini";

function contentToString(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => contentToString(part))
      .join(" ")
      .trim();
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  return "";
}

let pool;
function getCoreDb() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.CORE_DB_HOST,
      user: process.env.CORE_DB_USER,
      password: process.env.CORE_DB_PASSWORD,
      database: process.env.CORE_DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
    });
  }
  return pool;
}

async function coreQuery(sql, params = []) {
  const [rows] = await getCoreDb().execute(sql, params);
  return rows;
}

// --------- LLM SETUP ---------

const llm = new ChatOpenAI({
  model: MODEL_NAME,
  temperature: 0,
});

// --------- DATA FETCH HELPERS ---------

/**
 * Get list of user_ids that have activity (query_logs or conversations)
 * in the last X days.  Regardless of tenancy.
 */
async function getActiveUserIds({ days = 90 } = {}) {
  const rows = await coreQuery(
    `
  SELECT DISTINCT user_id, tenant_id
  FROM (
    SELECT q.user_id, q.tenant_id
    FROM query_logs q
    WHERE q.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)

    UNION

    SELECT c.user_id, c.tenant_id
    FROM conversations c
    WHERE c.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
  ) active_users
  `,
    [days, days]
  );

  return rows.map((r) => ({ userId: r.user_id, tenantId: r.tenant_id }));
}

/**
 * Fetch recent query logs for a user.
 * These give us questions + short answers.
 */
async function getUserRecentQueryLogs(userId, tenantId, { limit = 50 } = {}) {
  const safeLimit = Number.isFinite(Number(limit)) ? Number(limit) : 50;
  const rows = await coreQuery(
    `
    SELECT id, question, answer_summary, sql_query, created_at
    FROM query_logs
    WHERE user_id = ?
      AND tenant_id = ?
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `,
    [userId, tenantId]
  );
  return rows;
}

/**
 * Fetch conversation summaries for a user.
 */
async function getUserConversationSummaries(
  userId,
  tenantId,
  { limit = 20 } = {}
) {
  const safeLimit = Number.isFinite(Number(limit)) ? Number(limit) : 20;
  const rows = await coreQuery(
    `
    SELECT id, title, conversation_summary, updated_at
    FROM conversations
    WHERE user_id = ?
      AND tenant_id = ?
      AND conversation_summary IS NOT NULL
      AND conversation_summary != ''
    ORDER BY updated_at DESC, id DESC
    LIMIT ${safeLimit}
  `,
    [userId, tenantId]
  );
  return rows;
}

// --------- FORMATTING FOR LLM ---------

function formatQueryLogsForPrompt(logs) {
  if (!Array.isArray(logs) || logs.length === 0)
    return "(no recent query logs)";

  // reverse so oldest first for better narrative
  const ordered = [...logs].reverse();

  return ordered
    .map((log, idx) => {
      const n = idx + 1;
      const question = (log.question || "").trim();
      const answer = (log.answer_summary || "").trim();
      const sql = (log.sql_query || "").trim();
      const parts = [];

      parts.push(`Q${n}: ${question || "[no question]"}`);
      if (answer) parts.push(`A${n}: ${answer}`);
      if (sql) parts.push(`SQL: ${sql}`);

      return parts.join("\n");
    })
    .join("\n\n");
}

function formatConversationSummariesForPrompt(conversations) {
  if (!Array.isArray(conversations) || conversations.length === 0) {
    return "(no conversation summaries)";
  }

  return conversations
    .map((c, idx) => {
      const n = idx + 1;
      const title = (c.title || `Conversation ${c.id}`).trim();
      const summary = (c.conversation_summary || "").trim();
      const updatedAt = c.updated_at
        ? new Date(c.updated_at).toISOString()
        : "unknown date";

      return [
        `Conversation ${n}: ${title}`,
        `Last updated: ${updatedAt}`,
        `Summary: ${summary || "[no summary text]"}`,
      ].join("\n");
    })
    .join("\n\n");
}

// --------- MEMORY BUILDING VIA LLM ---------

async function buildUserMemorySummary(userId, tenantId) {
  const [logs, convs] = await Promise.all([
    getUserRecentQueryLogs(userId, tenantId),
    getUserConversationSummaries(userId, tenantId),
  ]);

  if ((!logs || logs.length === 0) && (!convs || convs.length === 0)) {
    console.log(`User ${userId}: no activity to summarize, skipping.`);
    return null;
  }

  const logsText = formatQueryLogsForPrompt(logs);
  const convsText = formatConversationSummariesForPrompt(convs);

  const memoryPrompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      [
        "You are building a long-term memory profile for a user of a retail analytics assistant.",
        "You will be given:",
        "- Recent natural-language questions, answers, and SQL queries the user has run.",
        "- Summaries of their past conversations.",
        "",
        "Your job is to produce a concise *long-term memory* summary of this user.",
        "",
        "Focus on:",
        "- Who this user seems to be (role, seniority, domain).",
        "- The kinds of metrics, reports, and analyses they frequently care about.",
        "- Stable preferences (e.g., currency assumptions, typical date ranges, recurring segments, favorite breakdowns).",
        "- Any recurring goals or projects that look long-lived (e.g., building dashboards, tracking store performance, loyalty program tuning).",
        "",
        "Do NOT include ephemeral details (exact numbers from one-off queries, specific error messages, etc.).",
        "Do NOT talk about the AI or the system itself; just describe the user and their stable habits/preferences.",
        "",
        "Write 1–3 short paragraphs or a bullet list. Max 250 words.",
      ].join(" "),
    ],
    [
      "human",
      [
        "Here are the user's recent query logs (questions, answers, SQL):",
        "",
        "{logs}",
        "",
        "Here are the user's recent conversation summaries:",
        "",
        "{conversations}",
        "",
        "Now write the long-term memory summary for this user.",
      ].join("\n"),
    ],
  ]);

  const messages = await memoryPrompt.formatMessages({
    logs: logsText,
    conversations: convsText,
  });

  const result = await llm.invoke(messages);
  const summary = contentToString(result.content).trim();

  if (!summary) {
    console.log(`User ${userId}: LLM returned empty summary, skipping.`);
    return null;
  }

  return summary;
}

// --------- DB WRITE ---------

async function insertUserMemorySummary(userId, tenantId, memorySummary) {
  // First try to update an existing record for this user
  const result = await coreQuery(
    `
    UPDATE user_long_term_memory
    SET memory_summary = ?, updated_at = NOW()
    WHERE user_id = ?
      AND tenant_id = ?
  `,
    [memorySummary, userId, tenantId]
  );

  // If no rows were updated, insert a new record
  if (!result || !result.affectedRows) {
    await coreQuery(
      `
      INSERT INTO user_long_term_memory (user_id, tenant_id, memory_summary)
      VALUES (?, ?, ?)
    `,
      [userId, tenantId, memorySummary]
    );
  }
}

// --------- MAIN JOB ---------

async function rebuildAllUserMemories() {
  console.log("Starting user_long_term_memory rebuild job...");

  const users = await getActiveUserIds({ days: 90 });
  console.log(`Found ${users.length} active users in last 90 days.`);

  let updatedCount = 0;
  let skippedCount = 0;

  for (const { userId, tenantId } of users) {
    try {
      console.log(
        `\n=== Building memory for user ${userId} (tenant ${tenantId}) ===`
      );
      const summary = await buildUserMemorySummary(userId, tenantId);

      if (!summary) {
        skippedCount += 1;
        continue;
      }

      await insertUserMemorySummary(userId, tenantId, summary);
      updatedCount += 1;
      console.log(
        `User ${userId} (tenant ${tenantId}): memory summary inserted.`
      );
    } catch (err) {
      console.error(
        `User ${userId} (tenant ${tenantId}): error while rebuilding memory:`,
        err
      );
    }
  }

  console.log("\nJob complete.");
  console.log(`Users updated: ${updatedCount}`);
  console.log(`Users skipped (no data or empty summary): ${skippedCount}`);
}

// Run if executed directly
rebuildAllUserMemories()
  .then(() => {
    console.log("Done.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Fatal error in rebuildUserLongTermMemory:", err);
    process.exit(1);
  });
