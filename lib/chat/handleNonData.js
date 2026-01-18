import { coreQuery } from "../db/coreDb";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { contentToString } from "./contentToString";

function emptyUsage() {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

function normalizeUsage(usage) {
  return {
    input_tokens: Number(usage?.input_tokens) || 0,
    output_tokens: Number(usage?.output_tokens) || 0,
    total_tokens: Number(usage?.total_tokens) || 0,
  };
}

function addUsage(total, next) {
  const safe = normalizeUsage(next);
  return {
    input_tokens: total.input_tokens + safe.input_tokens,
    output_tokens: total.output_tokens + safe.output_tokens,
    total_tokens: total.total_tokens + safe.total_tokens,
  };
}

function tokensFromUsage(modelName, usage) {
  return {
    model: modelName,
    input: usage.input_tokens,
    output: usage.output_tokens,
    total: usage.total_tokens,
  };
}

function fallbackNonDataText() {
  return (
    "Got it. This assistant is trained to answer questions by querying your data.  It cannot give answers that are outside the data it carries." +
    "If you’d like, ask what you want to see in the data and I’ll run the query for you."
  );
}

/**
 * Handle non-data questions (no DB query).
 * This function:
 * - Builds a friendly response
 * - Persists the assistant message
 * - Logs aggregated token usage
 * - Sends the final SSE response
 */

/**
 * Friendly response for non-data questions.
 */
async function buildNonDataResponse(question, llm) {
  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      [
        "You are the assistant for a retail analytics tool that answers questions by querying business data (via SQL).",
        "This tool is specifically for understanding data from the database.",
        "Sometimes users send messages that are not actually data questions (e.g., small talk, how-the-system-works questions, meta questions, or vague comments).",
        "",
        "Your job is to:",
        "- Respond in a friendly, concise way (1–3 sentences).",
        "- Acknowledge the content or intent of the user's message.",
        "- Clearly but gently remind them that this assistant is best used for questions about their data (metrics, reports, comparisons, trends, etc.).",
        "- Invite them to ask a concrete data question (Do not give examples).",
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
  const usage = resp.usage_metadata || emptyUsage();

  if (!text) {
    // Hard fallback if the model returns empty
    return {
      text:
        "Got it. This assistant is wired to answer questions by querying your data. " +
        "If you’d like, ask what you want to see in the data and I’ll run the query for you.",
      usage,
    };
  }

  return { text, usage };
}

export async function handleNonData({
  question,
  user,
  convId,
  emitStatus,
  closeWith,
  llm,
  MODEL_NAME,
  classificationUsage,
}) {
  let acknowledgment = "";
  let responseUsage = emptyUsage();
  try {
    emitStatus("Drafting response…", 60);
    const response = await buildNonDataResponse(question, llm);
    acknowledgment = response.text;
    responseUsage = response.usage || emptyUsage();
  } catch (ndErr) {
    console.error("Error building non-data response:", ndErr);
    acknowledgment = fallbackNonDataText();
  }

  const totalUsage = addUsage(
    addUsage(emptyUsage(), classificationUsage),
    responseUsage
  );

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
    chart: null,
    meta: {
      sql: null,
      sqlQueryId: null,
      tokens: tokensFromUsage(MODEL_NAME, totalUsage),
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
  const assistantMsgResult = await coreQuery(
    `INSERT INTO messages
       (tenant_id, conversation_id, role, content, answer_payload)
       VALUES (?, ?, ?, ?, ?)`,
    [
      user.tenantId,
      convId,
      "assistant",
      acknowledgment,
      JSON.stringify(answerPayload),
    ]
  );

  const assistantMessageId = assistantMsgResult.insertId;

  // Token usage: log aggregated usage for this non-data turn
  await coreQuery(
    `INSERT INTO token_usage
             (tenant_id, conversation_id, message_id, user_id, model, prompt_tokens, completion_tokens, total_tokens)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user.tenantId,
      convId,
      assistantMessageId,
      user.userId,
      MODEL_NAME,
      totalUsage.input_tokens,
      totalUsage.output_tokens,
      totalUsage.total_tokens,
    ]
  );

  const messages = await coreQuery(
    "SELECT id, role, content, answer_payload, created_at FROM messages WHERE conversation_id = ? AND tenant_id = ? ORDER BY created_at ASC, id ASC",
    [convId, user.tenantId]
  );

  emitStatus("Done.", 100);
  closeWith("final", {
    conversationId: convId,
    messages,
    answerPayload,
  });
}
