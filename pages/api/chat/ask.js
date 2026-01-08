// pages/api/chat/ask.js
// Streaming (SSE) chat endpoint: classifies request, optionally retrieves context (RAG/memory),
// generates SQL, runs it, summarizes results, and returns a stable `answerPayload` for the UI.

import { ChatOpenAI } from "@langchain/openai";

import { requireAuth } from "@/lib/auth/requireAuth";
import { createSse } from "@/lib/http/sse";
import { requirePost } from "@/lib/http/guards";
import { requireUserAndTenant } from "@/lib/http/tenantContext";

import { ensureConversationAndPersistUserMessage } from "@/lib/chat/conversationBootstrap";
import { classifyDataRequest } from "@/lib/chat/classifyDataRequest";
import { handleNonData } from "@/lib/chat/handleNonData";

import { buildConversationSummary } from "@/lib/chat/buildContext";
import { getRecentQAPairs } from "@/lib/chat/buildContext";
import { getUserLongTermMemorySummary } from "@/lib/chat/buildContext";
import { retrieveRAGContext } from "@/lib/chat/buildContext";
import { buildCombinedContext } from "@/lib/chat/buildContext";

import { getDataDbSchema } from "@/lib/db/getDataDbSchema";
import { convertToSQL } from "@/lib/chat/convertToSQL";
import { executeDataSQL } from "@/lib/chat/convertToSQL";
import { logFinalSQL } from "@/lib/chat/convertToSQL";

import { getAnswerText } from "@/lib/chat/buildAnswer";
import { logAnswerTelemetry } from "@/lib/chat/buildAnswer";
import { buildTable } from "@/lib/chat/buildAnswer";
import { buildAreaChart } from "@/lib/chat/buildAreaChart";
import { buildRagMeta } from "@/lib/chat/buildAnswer";
import { buildAnswerPayload } from "@/lib/chat/buildAnswer";
import { persistAssistantMessage } from "@/lib/chat/buildAnswer";
import { updateMessageSummary } from "@/lib/chat/buildAnswer";

const MODEL_NAME = "gpt-4.1-mini";
const llm = new ChatOpenAI({ model: MODEL_NAME, temperature: 0 });
const MAX_TABLE_ROWS_IN_RESPONSE = 20; // must match prompt rule unless user asks otherwise
const CSV_EXPORT_ROW_THRESHOLD = 21; // when >= this, include csv export payload

export default requireAuth(async function handler(req, res) {
  // ----------------------------------------------------
  // 1) Enable SSE, Check for POST, Get user and tenant info
  // ---------------------------------------------------

  //SSE setup
  const { emitStatus, streamError, closeWith } = createSse(res);

  //Check for POST
  if (!requirePost(req, streamError)) return;

  //Get user and tenant
  const ctx = await requireUserAndTenant(req, streamError);
  if (!ctx) return;
  const { user, tenant } = ctx;
  emitStatus("Starting analysis…", 2);

  // ----------------------------------------------------
  // 2) Validate request, persist user message, classify request
  // ---------------------------------------------------

  // Validate request body
  const { conversationId, question, useRag } = req.body;
  const useRagBool = useRag === "1" || useRag === true;
  if (typeof question !== "string" || question.trim() === "") {
    streamError(400, "INVALID_REQUEST", "Question is required");
    return;
  }

  try {
    // Persist conversation and user message
    const bootstrap = await ensureConversationAndPersistUserMessage({
      conversationId,
      question,
      user,
      streamError,
    });
    if (!bootstrap) return;
    const { convId, userMessageId } = bootstrap;
    emitStatus("Understanding your question…", 8);

    // Quick classification: data vs non-data
    const isDataRequest = await classifyDataRequest({
      question,
      emitStatus,
      llm,
    });

    // ----------------------------------------------------
    // 3) Handle Non-Data Requests
    // ---------------------------------------------------

    //Call Function for Non-Data Requests
    if (!isDataRequest) {
      await handleNonData({
        question,
        user,
        convId,
        emitStatus,
        closeWith,
        llm,
        MODEL_NAME,
      });
      return;
    }

    // ----------------------------------------------------
    // 4) Handle Data Requests: Gather context
    // ---------------------------------------------------

    //Handle Data Request
    emitStatus("Gathering user context…", 25);

    // Gather conversation summary
    const conversationSummaryForPrompt = await buildConversationSummary({
      convId,
      tenantId: user.tenantId,
    });

    // Gather user long-term memory
    const userMemorySummary = await getUserLongTermMemorySummary(user);

    // Get recent Q&A (excluding the current user question we just inserted)
    const recentQAPairsText = await getRecentQAPairs({
      convId,
      user: user,
    });

    emitStatus("Getting Business Context...", 35);

    //Retrive from RAG if enabled
    const { retrievedDocs, ragSourcesText, ragError } =
      await retrieveRAGContext({
        tenant,
        question,
        useRag: useRagBool,
      });

    // Build combined context string
    const ragContext = buildCombinedContext({
      recentQAPairsText,
      userMemorySummary,
      conversationSummaryForPrompt,
      ragSourcesText,
    });

    // ----------------------------------------------------
    // 5) Handle Data Requests: Convert Natural Language to SQL and Execute
    // ---------------------------------------------------

    emitStatus("Generating SQL query…", 50);

    // Get database schema text
    const schemaText = await getDataDbSchema(tenant);

    //Carry out natural language to SQL conversion
    let { sql, usage: sqlUsage } = await convertToSQL({
      llm,
      question,
      schemaText,
      context: ragContext,
      maxRows: MAX_TABLE_ROWS_IN_RESPONSE,
    });

    emitStatus("Running query on database…", 65);

    //Run actual SQL against tenant data database
    const {
      sql: executedSql,
      rows,
      fields,
      rowCount,
      durationMs,
      status,
      errorMessage,
    } = await executeDataSQL({ tenant, sql });

    const finalSql = executedSql;

    // Persist final SQL metadata
    const sqlQueryId = await logFinalSQL({
      tenantId: user.tenantId,
      conversationId: convId,
      messageId: userMessageId,
      finalSql,
      status,
      rowCount,
      errorMessage,
      durationMs,
    });

    // ----------------------------------------------------
    // 6) Handle Data Requests: Prepare data for UI Packaging
    // ---------------------------------------------------

    emitStatus("Summarizing results…", 80);

    //Get concise answer text from results
    const { answerText, usage } = await getAnswerText({
      llm,
      question,
      sql,
      fields,
      rows,
    });

    //Log telemetry (query_logs + query_sources)
    const queryLogId = await logAnswerTelemetry({
      tenantId: user.tenantId,
      userId: user.userId,
      conversationId: convId,
      question,
      answerText,
      sql,
      usage,
      durationMs,
      modelName: MODEL_NAME,
      useRagBool,
      retrievedDocs,
    });

    //Build table + optional CSV download
    const { table, downloads } = buildTable({
      fields,
      rows,
      convId,
      maxRows: MAX_TABLE_ROWS_IN_RESPONSE,
      csvThreshold: CSV_EXPORT_ROW_THRESHOLD,
    });

    //Build Optional chart payload
    const chart = await buildAreaChart({
      question,
      fields,
      rows,
      llm,
    });

    //Build RAG metadata
    const ragMeta = buildRagMeta({
      requested: useRagBool,
      retrievedDocs,
      ragError,
    });

    //Build answerPayload (UI contract)
    const answerPayload = buildAnswerPayload({
      answerText,
      sql,
      sqlQueryId,
      usage,
      modelName: MODEL_NAME,
      table,
      downloads,
      chart,
      rag: ragMeta,
    });

    emitStatus("Finalizing response…", 92);

    // ----------------------------------------------------
    // 7) Handle Data Requests: Complete logs and SSE response
    // ---------------------------------------------------

    // Persist assistant message & TokenUsage
    const persistenceId = await persistAssistantMessage({
      tenantId: user.tenantId,
      userId: user.userId,
      conversationId: convId,
      answerText,
      answerPayload,
      modelName: MODEL_NAME,
      usage,
    });
    console.log("Persisted assistant message with ID:", persistenceId);

    //Update conversation summary if needed
    const messages = await updateMessageSummary({
      convId,
      conversationSummaryForPrompt,
      user,
      llm,
    });

    //Send final SSE response
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
});
