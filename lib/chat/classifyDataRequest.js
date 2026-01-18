// lib/chat/classifyDataRequest.js

/********************************/
/* Decide if a question should hit the database.
/* Returns true for likely-data questions, false for non-data questions.
/* Permissive on failure (defaults to data request)
/* Emits appropriate SSE status
/********************************/

import { ChatPromptTemplate } from "@langchain/core/prompts";
import { contentToString } from "@/lib/chat/contentToString";

function emptyUsage() {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

async function isDataQuestion(question, llm) {
  const classifyPrompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      [
        "You are a classifier in a retail analytics assistant.",
        "Your job is to decide if the user is asking for data from the database",
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
  const usage = resp.usage_metadata || emptyUsage();

  if (text.startsWith("YES")) return { isDataRequest: true, usage };
  if (text.startsWith("NO")) return { isDataRequest: false, usage };

  // Fallback: be permissive so we don't block valid use
  return { isDataRequest: true, usage };
}

export async function classifyDataRequest({ question, emitStatus, llm }) {
  let isDataRequest = true;
  let usage = emptyUsage();

  try {
    const result = await isDataQuestion(question, llm);
    isDataRequest = result.isDataRequest;
    usage = result.usage || emptyUsage();
  } catch (err) {
    console.error("Error classifying question as data/non-data:", err);
    isDataRequest = true; // permissive fallback
  }

  emitStatus(
    isDataRequest ? "Preparing to query your data…" : "Preparing response…",
    isDataRequest ? 15 : 20
  );

  return { isDataRequest, usage };
}
