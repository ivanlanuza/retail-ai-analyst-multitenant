import { coreQuery } from "../db/coreDb";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { contentToString } from "./contentToString";

/**
 * Handle non-data questions (no DB query).
 * This function:
 * - Builds a friendly response
 * - Persists the assistant message
 * - Logs zero token usage
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
      "Got it. This assistant is wired to answer questions by querying your data. " +
      "If you’d like, ask what you want to see in the data and I’ll run the query for you."
    );
  }

  return text;
}

export async function handleNonData({
  question,
  user,
  convId,
  emitStatus,
  closeWith,
  llm,
  MODEL_NAME,
}) {
  let acknowledgment;
  try {
    emitStatus("Drafting response…", 60);
    acknowledgment = await buildNonDataResponse(question, llm);
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
    chart: null,
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

  // Token usage: explicitly log zeroed usage for non-data turn
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
      0,
      0,
      0,
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
