/* Used to create and manage Server-Sent Events (SSE) connections: For streaming responses back to UI. */

export function createSse(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // SSE helpers
  function emit(event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  function clampPercent(raw) {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, n));
  }

  function emitProgress(progress) {
    const pct = clampPercent(progress);
    if (pct == null) return;
    emit("progress", { progress: pct });
  }

  function emitStatus(message, progress = null) {
    const payload = { message };

    const pct = progress == null ? null : clampPercent(progress);
    if (pct != null) {
      payload.progress = pct;
    }

    emit("status", payload);

    // Also emit a dedicated progress event for UIs that prefer it.
    if (pct != null) {
      emitProgress(pct);
    }
  }

  function closeWith(event, payload, statusCode = 200) {
    res.statusCode = statusCode;
    emit(event, payload);
    res.end();
  }

  function streamError(statusCode, code, message, extra = {}) {
    closeWith("error", { code, message, ...extra }, statusCode);
  }

  return {
    emit,
    emitStatus,
    emitProgress,
    closeWith,
    streamError,
  };
}
