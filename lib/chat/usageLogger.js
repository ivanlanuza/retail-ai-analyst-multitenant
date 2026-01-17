import { coreQuery } from "@/lib/db/coreDb";
import { buildAnswerPayload } from "@/lib/chat/buildAnswer";

export function emptyUsage() {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

function normalizeUsage(usage) {
  return {
    input_tokens: Number(usage?.input_tokens) || 0,
    output_tokens: Number(usage?.output_tokens) || 0,
    total_tokens: Number(usage?.total_tokens) || 0,
  };
}

export function addUsage(total, next) {
  const safe = normalizeUsage(next);
  return {
    input_tokens: total.input_tokens + safe.input_tokens,
    output_tokens: total.output_tokens + safe.output_tokens,
    total_tokens: total.total_tokens + safe.total_tokens,
  };
}

export function hasUsage(usage) {
  return (
    usage &&
    (usage.input_tokens > 0 ||
      usage.output_tokens > 0 ||
      usage.total_tokens > 0)
  );
}

export async function applySummaryUsageUpdate({
  summaryUsage,
  totalUsage,
  answerText,
  sql,
  sqlQueryId,
  modelName,
  table,
  downloads,
  chart,
  ragMeta,
  messageId,
  tenantId,
  tokenUsageId,
  messages,
}) {
  if (!hasUsage(summaryUsage)) {
    return { answerPayload: null, messages };
  }

  const answerPayload = buildAnswerPayload({
    answerText,
    sql,
    sqlQueryId,
    usage: totalUsage,
    modelName,
    table,
    downloads,
    chart,
    rag: ragMeta,
  });

  await coreQuery(
    "UPDATE messages SET answer_payload = ? WHERE id = ? AND tenant_id = ?",
    [JSON.stringify(answerPayload), messageId, tenantId]
  );

  await coreQuery(
    `UPDATE token_usage
     SET prompt_tokens = ?, completion_tokens = ?, total_tokens = ?
     WHERE id = ?`,
    [
      totalUsage.input_tokens,
      totalUsage.output_tokens,
      totalUsage.total_tokens,
      tokenUsageId,
    ]
  );

  const messageRow = messages.find((m) => m.id === messageId);
  if (messageRow) {
    messageRow.answer_payload = JSON.stringify(answerPayload);
  }

  return { answerPayload, messages };
}
