// scripts/rebuildUserLongTermMemory.mjs
//
// Periodic job to rebuild user_long_term_memory from query_logs + conversations.
//
// Usage:
//   node scripts/rebuildUserLongTermMemory.mjs
//
// You can wire this into cron / GitHub Actions / PM2, etc.

import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { query } from "../lib/db.mjs";

const MODEL_NAME = "gpt-4o-mini";

// --------- LLM SETUP ---------

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

// --------- DATA FETCH HELPERS ---------

/**
 * Get list of user_ids that have activity (query_logs or conversations)
 * in the last X days.
 */
async function getActiveUserIds({ days = 90 } = {}) {
  const rows = await query(
    `
    SELECT DISTINCT u.id AS user_id
    FROM users u
    LEFT JOIN query_logs q ON q.user_id = u.id
    LEFT JOIN conversations c ON c.user_id = u.id
    WHERE
      (q.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       OR c.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY))
      AND (q.id IS NOT NULL OR c.id IS NOT NULL)
  `,
    [days, days]
  );

  return rows.map((r) => r.user_id);
}

/**
 * Fetch recent query logs for a user.
 * These give us questions + short answers.
 */
async function getUserRecentQueryLogs(userId, { limit = 50 } = {}) {
  const safeLimit = Number.isFinite(Number(limit)) ? Number(limit) : 50;
  const rows = await query(
    `
    SELECT id, question, answer_summary, sql_query, created_at
    FROM query_logs
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `,
    [userId]
  );
  return rows;
}

/**
 * Fetch conversation summaries for a user.
 */
async function getUserConversationSummaries(userId, { limit = 20 } = {}) {
  const safeLimit = Number.isFinite(Number(limit)) ? Number(limit) : 20;
  const rows = await query(
    `
    SELECT id, title, conversation_summary, updated_at
    FROM conversations
    WHERE user_id = ?
      AND conversation_summary IS NOT NULL
      AND conversation_summary != ''
    ORDER BY updated_at DESC, id DESC
    LIMIT ${safeLimit}
  `,
    [userId]
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

async function buildUserMemorySummary(userId) {
  const [logs, convs] = await Promise.all([
    getUserRecentQueryLogs(userId),
    getUserConversationSummaries(userId),
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

async function insertUserMemorySummary(userId, memorySummary) {
  // First try to update an existing record for this user
  const result = await query(
    `
    UPDATE user_long_term_memory
    SET memory_summary = ?, updated_at = NOW()
    WHERE user_id = ?
  `,
    [memorySummary, userId]
  );

  // If no rows were updated, insert a new record
  if (!result || !result.affectedRows) {
    await query(
      `
      INSERT INTO user_long_term_memory (user_id, memory_summary)
      VALUES (?, ?)
    `,
      [userId, memorySummary]
    );
  }
}

// --------- MAIN JOB ---------

async function rebuildAllUserMemories() {
  console.log("Starting user_long_term_memory rebuild job...");

  const userIds = await getActiveUserIds({ days: 90 });
  console.log(`Found ${userIds.length} active users in last 90 days.`);

  let updatedCount = 0;
  let skippedCount = 0;

  for (const userId of userIds) {
    try {
      console.log(`\n=== Building memory for user ${userId} ===`);
      const summary = await buildUserMemorySummary(userId);

      if (!summary) {
        skippedCount += 1;
        continue;
      }

      await insertUserMemorySummary(userId, summary);
      updatedCount += 1;
      console.log(`User ${userId}: memory summary inserted.`);
    } catch (err) {
      console.error(`User ${userId}: error while rebuilding memory:`, err);
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
