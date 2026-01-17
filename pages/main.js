// pages/main.js
// Main dashboard UI: conversation list + chat + inline result tables + feedback + stats.

import { withAuth } from "@/lib/auth/withAuth";
import { useAuth } from "@/lib/auth/AuthContext";
import { getToken } from "@/lib/auth/clientAuth";

import { useEffect, useRef, useState } from "react";
import { Geist, Geist_Mono } from "next/font/google";

import dynamic from "next/dynamic";

//import { getUserFromRequest } from "../lib/auth";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { Copy, Download, Settings, ThumbsDown, ThumbsUp } from "lucide-react";
import { saveAs } from "file-saver";
import Papa from "papaparse";

import { useVirtualizer } from "@tanstack/react-virtual";

// -----------------------------
// Charts (client-only)
// -----------------------------

// We must load Recharts on the client only. `dynamic()` returns a React component,
// so we wrap the Recharts module into a single chart component.
const BasicAreaChartInner = dynamic(
  () =>
    import("recharts").then((mod) => {
      const {
        ResponsiveContainer,
        AreaChart,
        Area,
        XAxis,
        YAxis,
        Tooltip,
        CartesianGrid,
      } = mod;

      function Chart({ data, xKey, yKey }) {
        return (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={data}
              margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey={xKey} tick={{ fontSize: 10 }} minTickGap={24} />
              <YAxis tick={{ fontSize: 10 }} width={44} />
              <Tooltip />
              <Area
                type="monotone"
                dataKey={yKey}
                stroke="#B71C1C"
                fill="#FECACA"
                fillOpacity={0.5}
                strokeWidth={2}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        );
      }

      Chart.displayName = "BasicAreaChartInner";
      return Chart;
    }),
  { ssr: false }
);

// -----------------------------
// Fonts
// -----------------------------

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// -----------------------------
// UI constants
// -----------------------------

const STREAMING_MESSAGE_ID = "streaming";
const TOAST_TIMEOUT_MS = 1200;

// -----------------------------
// Display formatters
// -----------------------------

const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 6,
});

function formatCellValue(value) {
  if (value == null) return "";

  // Format numbers
  if (typeof value === "number" && Number.isFinite(value)) {
    return numberFormatter.format(value);
  }

  // Format numeric strings (e.g., "12345.67" or "12,345.67")
  if (typeof value === "string") {
    const t = value.trim();
    if (t) {
      const maybe = Number(t.replace(/,/g, ""));
      if (Number.isFinite(maybe)) {
        return numberFormatter.format(maybe);
      }
    }
    return t;
  }

  // Keep dates readable.
  if (value instanceof Date && Number.isFinite(value.getTime?.())) {
    return value.toISOString().slice(0, 10);
  }

  return String(value);
}

// -----------------------------
// AnswerPayload helpers
// -----------------------------

/**
 * Ensures we always have a consistent answerPayload shape.
 * (Important: this is UI-contract glue; keep behavior stable.)
 */
function normalizeAnswerPayload(payload) {
  if (!payload || typeof payload !== "object") return null;

  const normalized = { ...payload };

  if (normalized.table && typeof normalized.table === "object") {
    const table = normalized.table;
    const rows = Array.isArray(table.rows) ? table.rows : [];
    let columns = Array.isArray(table.columns) ? table.columns : [];

    // If columns are missing but rows are objects, infer column order from the first row.
    if (
      columns.length === 0 &&
      rows.length > 0 &&
      rows[0] &&
      typeof rows[0] === "object"
    ) {
      columns = Object.keys(rows[0]);
    }

    normalized.table = {
      columns,
      rows,
      rowCount:
        typeof table.rowCount === "number" ? table.rowCount : rows.length,
      truncated: !!table.truncated,
    };
  }

  // Normalize optional chart payload
  if (normalized.chart && typeof normalized.chart === "object") {
    const chart = normalized.chart;

    // Only one chart type for now
    if (
      chart.type === "basicareachart" &&
      typeof chart.xKey === "string" &&
      typeof chart.yKey === "string" &&
      Array.isArray(chart.data)
    ) {
      normalized.chart = {
        type: "basicareachart",
        xKey: chart.xKey,
        yKey: chart.yKey,
        data: chart.data,
      };
    } else {
      normalized.chart = null;
    }
  } else if (normalized.chart == null) {
    normalized.chart = null;
  }

  return normalized;
}

/**
 * Backward compatible extractor.
 * - Prefer `data.answerPayload` (new)
 * - Fall back to legacy fields (`answer`, `table`, etc.)
 */
function getAnswerPayloadFromApiResponse(data) {
  let payload = data?.answerPayload || null;

  if (!payload) {
    const legacyTable = data?.table || null;

    payload = {
      version: "v1",
      status: data?.status || "complete",
      answerText: data?.answer || "",
      table: legacyTable
        ? {
            columns: Array.isArray(legacyTable.columns)
              ? legacyTable.columns
              : [],
            rows: Array.isArray(legacyTable.rows) ? legacyTable.rows : [],
            rowCount: Array.isArray(legacyTable.rows)
              ? legacyTable.rows.length
              : 0,
            truncated: false,
          }
        : {
            columns: [],
            rows: [],
            rowCount: 0,
            truncated: false,
          },
      downloads: [],
      chart: null,
      meta: {
        sql: data?.sql || null,
        sqlQueryId: data?.sqlQueryId || null,
        tokens: data?.tokens || null,
        rag: data?.rag || null,
      },
    };
  }

  return normalizeAnswerPayload(payload) || payload;
}

/**
 * Rebuild a per-message lookup of answer payload metadata from the server messages.
 * Stored in state as `answerMetaByMessageId`.
 */
function buildAnswerMetaByMessage(messages, conversationId) {
  const rebuilt = {};
  if (!Array.isArray(messages)) return rebuilt;

  messages.forEach((m) => {
    if (m.role !== "assistant") return;

    const rawPayload = m.answer_payload ?? m.answerPayload;
    if (!rawPayload) return;

    let parsedPayload = null;
    try {
      parsedPayload =
        typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
    } catch (err) {
      console.error("Failed to parse answer payload for message", m.id, err);
      return;
    }

    const normalized = normalizeAnswerPayload(parsedPayload);
    if (!normalized) return;

    rebuilt[m.id] = {
      conversationId,
      answerPayload: normalized,
      sql: normalized?.meta?.sql ?? null,
      tokens: normalized?.meta?.tokens ?? null,
      rag: normalized?.meta?.rag ?? null,
    };
  });

  return rebuilt;
}

function downloadCsvFromPayload(payload) {
  const dl = payload?.downloads?.find(
    (d) => d && d.kind === "csv" && typeof d.content === "string"
  );
  if (!dl) return;

  try {
    const blob = new Blob([dl.content], { type: dl.mimeType || "text/csv" });
    saveAs(blob, dl.filename || "export.csv");
  } catch (err) {
    console.error("CSV download failed:", err);
  }
}

// -----------------------------
// Virtualized table (for large tables)
// -----------------------------

function VirtualTable({ columns, rows, maxHeight = 420 }) {
  const parentRef = useRef(null);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 12,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  return (
    <div
      ref={parentRef}
      className="overflow-auto rounded-md border border-neutral-200 bg-white"
      style={{ maxHeight }}
    >
      <table className="min-w-full border-collapse text-[12px]">
        <thead className="sticky top-0 z-10 bg-neutral-50">
          <tr>
            {columns.map((col) => (
              <th
                key={col}
                className="px-2 py-1 text-left font-medium text-neutral-700"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td
              colSpan={columns.length}
              style={{ height: totalSize, padding: 0, border: "none" }}
            >
              <div style={{ position: "relative", height: totalSize }}>
                {virtualItems.map((vi) => {
                  const row = rows[vi.index];

                  return (
                    <div
                      key={vi.key}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${vi.start}px)`,
                      }}
                    >
                      <div
                        className={
                          vi.index % 2 === 0 ? "bg-white" : "bg-neutral-50"
                        }
                      >
                        <div
                          className="grid"
                          style={{
                            gridTemplateColumns: `repeat(${columns.length}, minmax(140px, 1fr))`,
                          }}
                        >
                          {columns.map((col) => (
                            <div
                              key={col}
                              className="px-2 py-1 whitespace-nowrap font-mono text-[10px] text-neutral-800"
                            >
                              {formatCellValue(row?.[col])}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// -----------------------------
// SSE parsing helpers
// -----------------------------

function parseSseEvent(chunk) {
  if (!chunk) return { eventName: "message", data: "" };

  const lines = chunk.split(/\r?\n/);
  let eventName = "message";
  const dataLines = [];

  lines.forEach((line) => {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      return;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  });

  return { eventName, data: dataLines.join("\n") };
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function clampProgress(raw) {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

// -----------------------------
// Dashboard page
// -----------------------------

//export default function DashboardPage({ user }) {
function MainPage() {
  const { user, tenant, logout } = useAuth();
  // Conversations + messages
  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState(null);
  const [messages, setMessages] = useState([]);

  // Input
  const [question, setQuestion] = useState("What is my average basket size?");

  // Loading states
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);

  // Stats + modals
  const [stats, setStats] = useState({ sqlQueries: [], tokenUsage: [] });
  const [loadingStats, setLoadingStats] = useState(false);
  const [isStatsModalOpen, setIsStatsModalOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isUsageModalOpen, setIsUsageModalOpen] = useState(false);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageSummary, setUsageSummary] = useState({
    lifetimeTotalTokens: 0,
    monthTotalTokens: 0,
    weekTotalTokens: 0,
    daily: [],
  });

  // Active answer selection
  const [activeAnswer, setActiveAnswer] = useState(null);
  const [answerMetaByMessageId, setAnswerMetaByMessageId] = useState({});
  const [activeAnswerMeta, setActiveAnswerMeta] = useState(null);
  const [activeAnswerPayload, setActiveAnswerPayload] = useState(null);
  const [showAdvancedStats, setShowAdvancedStats] = useState(false);

  // Settings toggles
  const [useRag, setUseRag] = useState(true);
  const [showInlineVisuals, setShowInlineVisuals] = useState(true);

  // User memory editor
  const [userMemorySummary, setUserMemorySummary] = useState("");
  const [loadingUserMemory, setLoadingUserMemory] = useState(false);
  const [savingUserMemory, setSavingUserMemory] = useState(false);
  const [userMemoryError, setUserMemoryError] = useState(null);

  // Feedback + copy UI
  const [feedbackByMessageId, setFeedbackByMessageId] = useState({});
  const [isFeedbackModalOpen, setIsFeedbackModalOpen] = useState(false);
  const [feedbackTarget, setFeedbackTarget] = useState(null); // { messageId, conversationId }
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [copyStatusByMessageId, setCopyStatusByMessageId] = useState({});
  const [feedbackToastByMessageId, setFeedbackToastByMessageId] = useState({});

  // Streaming management
  const streamControllerRef = useRef(null);
  const [hasStartedChat, setHasStartedChat] = useState(false);
  const [streamingProgress, setStreamingProgress] = useState(null);
  const [streamingProgressTarget, setStreamingProgressTarget] = useState(null);
  const [isClient, setIsClient] = useState(false);

  // Auto-scroll
  const messagesEndRef = useRef(null);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  useEffect(() => {
    if (typeof streamingProgressTarget !== "number") return;

    const tickMs = 50;

    const id = window.setInterval(() => {
      let finished = false;

      setStreamingProgress((prev) => {
        const current = typeof prev === "number" ? prev : 0;
        const target = streamingProgressTarget;

        if (current >= target) {
          finished = true;
          return current;
        }

        // Incremental movement (small steps), with gentle acceleration on bigger gaps.
        const gap = target - current;
        const step = Math.max(0.4, gap * 0.04); // min 0.6% per tick
        const next = Math.min(target, current + step);

        if (next >= target) finished = true;
        return next;
      });

      if (finished) window.clearInterval(id);
    }, tickMs);

    return () => window.clearInterval(id);
  }, [streamingProgressTarget]);

  // Initial load + cleanup
  useEffect(() => {
    fetchConversations();
  }, []);

  // Client-only (avoid SSR issues for chart libs)
  useEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    return () => {
      if (streamControllerRef.current) {
        streamControllerRef.current.abort();
      }
    };
  }, []);

  // -----------------------------
  // Data fetching
  // -----------------------------

  const handleLogout = () => {
    logout();
  };

  async function fetchConversations() {
    console.log("Fetching conversations...");
    setLoadingConversations(true);
    try {
      const res = await fetch("/api/chat/conversations", {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },
      });
      if (!res.ok) throw new Error("Failed to load conversations");
      const data = await res.json();
      setConversations(data.conversations || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingConversations(false);
    }
  }

  async function fetchMessages(conversationId) {
    if (!conversationId) return;

    setLoadingMessages(true);
    try {
      const res = await fetch(
        `/api/chat/messages?conversationId=${conversationId}`,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${getToken()}`,
          },
        }
      );
      if (!res.ok) throw new Error("Failed to load messages");

      const data = await res.json();
      const msgs = data.messages || [];

      setMessages(msgs);
      setAnswerMetaByMessageId(buildAnswerMetaByMessage(msgs, conversationId));
      setActiveAnswerMeta(null);
      setActiveAnswerPayload(null);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingMessages(false);
    }
  }

  async function fetchStats(conversationId) {
    if (!conversationId) {
      setStats({ sqlQueries: [], tokenUsage: [] });
      return;
    }

    setLoadingStats(true);
    try {
      const res = await fetch(
        `/api/chat/stats?conversationId=${conversationId}`,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${getToken()}`,
          },
        }
      );
      if (!res.ok) throw new Error("Failed to load stats");
      const data = await res.json();

      setStats({
        sqlQueries: data.sqlQueries || [],
        tokenUsage: data.tokenUsage || [],
      });
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingStats(false);
    }
  }

  // -----------------------------
  // Usage stats modal
  // -----------------------------

  async function openUsageStats() {
    setIsSettingsOpen(false);
    setIsUsageModalOpen(true);
    setUsageLoading(true);

    try {
      const res = await fetch("/api/chat/usage", {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },
      });
      const data = await res.json();

      console.log("Usage data:", data);

      if (!res.ok) {
        console.error(data.error || "Failed to load usage stats");
        return;
      }

      const summary = data.summary || {};

      const lifetime =
        data.lifetimeTotalTokens ??
        summary.lifetime_total ??
        summary.lifetimeTokens ??
        0;

      const month =
        data.monthTotalTokens ??
        summary.month_total ??
        summary.monthTokens ??
        0;

      const week =
        data.weekTotalTokens ?? summary.week_total ?? summary.weekTokens ?? 0;

      const dailyArray = Array.isArray(data.daily) ? data.daily : [];

      setUsageSummary({
        lifetimeTotalTokens: Number(lifetime) || 0,
        monthTotalTokens: Number(month) || 0,
        weekTotalTokens: Number(week) || 0,
        daily: dailyArray.map((d) => {
          const rawDate = d.date;
          const dateStr =
            typeof rawDate === "string"
              ? rawDate
              : rawDate instanceof Date
              ? rawDate.toISOString().slice(0, 10)
              : new Date(rawDate).toISOString().slice(0, 10);

          const value =
            d.totalTokens ??
            d.total_tokens ??
            d.total ??
            d.total_tokens_sum ??
            0;

          return {
            date: dateStr,
            totalTokens: Number(value) || 0,
          };
        }),
      });
    } catch (err) {
      console.error("Error loading usage stats:", err);
    } finally {
      setUsageLoading(false);
    }
  }

  // -----------------------------
  // Settings modal (user memory)
  // -----------------------------

  function openSettingsModal() {
    setIsSettingsOpen(false);
    setIsSettingsModalOpen(true);
    loadUserMemory();
  }

  async function loadUserMemory() {
    setLoadingUserMemory(true);
    setUserMemoryError(null);

    try {
      const res = await fetch("/api/user/memory", {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },
      });
      const data = await res.json();

      if (!res.ok) {
        console.error(data.error || "Failed to load user memory");
        setUserMemoryError(data.error || "Failed to load user memory.");
        return;
      }

      setUserMemorySummary(data.memorySummary || "");
    } catch (err) {
      console.error("Error loading user memory:", err);
      setUserMemoryError("Error loading user memory.");
    } finally {
      setLoadingUserMemory(false);
    }
  }

  async function saveUserMemory() {
    setSavingUserMemory(true);
    setUserMemoryError(null);

    try {
      const res = await fetch("/api/user/memory", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },

        body: JSON.stringify({ memorySummary: userMemorySummary }),
      });

      const data = await res.json();

      if (!res.ok) {
        console.error(data.error || "Failed to save user memory");
        setUserMemoryError(data.error || "Failed to save user memory.");
        return;
      }

      // Normalize summary from server in case it modified/trimmed it
      setUserMemorySummary(data.memorySummary || "");
    } catch (err) {
      console.error("Error saving user memory:", err);
      setUserMemoryError("Error saving user memory.");
    } finally {
      setSavingUserMemory(false);
    }
  }

  // -----------------------------
  // Conversation selection
  // -----------------------------

  function abortStreamingIfAny() {
    if (streamControllerRef.current) {
      streamControllerRef.current.abort();
      streamControllerRef.current = null;
    }
    setStreamingProgress(null);
    setStreamingProgressTarget(null);
  }

  function handleSelectConversation(id) {
    setSelectedConversationId(id);

    setHasStartedChat(true);
    abortStreamingIfAny();

    setAnswerMetaByMessageId({});
    setActiveAnswerMeta(null);
    setActiveAnswerPayload(null);

    fetchMessages(id);
    fetchStats(id);
  }

  function handleNewConversation() {
    abortStreamingIfAny();

    setSelectedConversationId(null);
    setMessages([]);
    setQuestion("");

    setStats({ sqlQueries: [], tokenUsage: [] });

    setAnswerMetaByMessageId({});
    setActiveAnswerMeta(null);
    setActiveAnswerPayload(null);

    setUseRag(true);
    setHasStartedChat(false);
    setStreamingProgress(null);
    setStreamingProgressTarget(null);

    setFeedbackByMessageId({});
    setCopyStatusByMessageId({});
    setFeedbackToastByMessageId({});

    setIsFeedbackModalOpen(false);
    setFeedbackTarget(null);
    setFeedbackText("");
    setFeedbackSubmitting(false);
  }

  // -----------------------------
  // Feedback + copy helpers
  // -----------------------------

  function showToastForMessage(setter, messageId, value) {
    setter((prev) => ({ ...prev, [messageId]: value }));

    window.setTimeout(() => {
      setter((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
    }, TOAST_TIMEOUT_MS);
  }

  async function postAnswerFeedback({
    conversationId,
    messageId,
    rating,
    reason,
  }) {
    // Expected: POST /api/chat/feedback { conversationId, messageId, rating, reason }
    try {
      const res = await fetch("/api/chat/feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },

        body: JSON.stringify({
          conversationId,
          messageId,
          rating,
          reason: reason || null,
        }),
      });

      if (!res.ok) {
        let payload = null;
        try {
          payload = await res.json();
        } catch (_) {
          // ignore
        }
        console.error(
          "Feedback API failed:",
          res.status,
          payload?.error || payload || "unknown error"
        );
        return { ok: false };
      }

      return { ok: true };
    } catch (err) {
      console.error("Feedback API error:", err);
      return { ok: false };
    }
  }

  function openFeedbackModalForMessage(messageId) {
    const convId = selectedConversationId;
    setFeedbackTarget({ messageId, conversationId: convId });
    setFeedbackText("");
    setIsFeedbackModalOpen(true);
  }

  async function submitThumbsUp(messageId) {
    const convId = selectedConversationId;
    if (!convId) return;

    // optimistic UI
    setFeedbackByMessageId((prev) => ({
      ...prev,
      [messageId]: { rating: "up", submittedAt: Date.now() },
    }));

    // subtle UI feedback (like copy)
    showToastForMessage(setFeedbackToastByMessageId, messageId, "up");

    const result = await postAnswerFeedback({
      conversationId: convId,
      messageId,
      rating: "up",
      reason: null,
    });

    if (!result.ok) {
      // roll back
      setFeedbackByMessageId((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
      setFeedbackToastByMessageId((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
    }
  }

  async function submitThumbsDown() {
    const convId = feedbackTarget?.conversationId;
    const messageId = feedbackTarget?.messageId;
    if (!convId || !messageId) return;

    setFeedbackSubmitting(true);

    // optimistic UI
    setFeedbackByMessageId((prev) => ({
      ...prev,
      [messageId]: { rating: "down", submittedAt: Date.now() },
    }));

    const result = await postAnswerFeedback({
      conversationId: convId,
      messageId,
      rating: "down",
      reason: feedbackText.trim() || null,
    });

    setFeedbackSubmitting(false);

    if (!result.ok) {
      // roll back
      setFeedbackByMessageId((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
      return;
    }

    setIsFeedbackModalOpen(false);
    setFeedbackTarget(null);
    setFeedbackText("");

    // subtle UI feedback (like copy)
    showToastForMessage(setFeedbackToastByMessageId, messageId, "down");
  }

  function buildCopyTextForMessage(messageId) {
    const msg = messages.find((m) => m.id === messageId);
    const answerText = msg?.content || "";

    const payload = answerMetaByMessageId?.[messageId]?.answerPayload;
    const table = payload?.table;
    const columns = Array.isArray(table?.columns) ? table.columns : [];
    const rows = Array.isArray(table?.rows) ? table.rows : [];

    let tableText = "";

    if (columns.length > 0 && rows.length > 0) {
      try {
        // Build a CSV using column order.
        const normalizedRows = rows.map((r) => {
          const out = {};
          columns.forEach((c) => {
            out[c] = r?.[c] == null ? "" : r[c];
          });
          return out;
        });

        tableText = Papa.unparse(normalizedRows, { columns });
      } catch (err) {
        console.error("Failed to build CSV for clipboard:", err);
      }
    }

    return tableText ? `${answerText}\n\n---\n\n${tableText}` : answerText;
  }

  async function copyMessageToClipboard(messageId) {
    const text = buildCopyTextForMessage(messageId);
    if (!text) return;

    let ok = false;

    // Preferred clipboard API
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (err) {
      console.warn("navigator.clipboard failed, falling back:", err);
    }

    // Fallback for older browsers
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch (err) {
        console.error("Clipboard fallback failed:", err);
      }
    }

    if (ok) {
      showToastForMessage(setCopyStatusByMessageId, messageId, "copied");
    }
  }

  // -----------------------------
  // Ask / SSE streaming
  // -----------------------------

  function upsertStreamingStatusMessage(message) {
    setMessages((prev) => {
      let found = false;

      const updated = prev.map((m) => {
        if (m.id === STREAMING_MESSAGE_ID) {
          found = true;
          return { ...m, content: message };
        }
        return m;
      });

      if (!found) {
        updated.push({
          id: STREAMING_MESSAGE_ID,
          role: "assistant",
          content: message,
        });
      }

      return updated;
    });
  }

  function replaceStreamingWithError(message) {
    setMessages((prev) => [
      ...prev.filter((m) => m.id !== STREAMING_MESSAGE_ID),
      {
        id: `error-${Date.now()}`,
        role: "assistant",
        content: `Error: ${message}`,
      },
    ]);
  }

  function bumpStreamingProgressTarget(raw) {
    const pct = clampProgress(raw);
    if (pct == null) return;

    // Don’t go backwards during a single stream.
    setStreamingProgressTarget((prev) => {
      const current = typeof prev === "number" ? prev : 0;
      return pct < current ? current : pct;
    });
  }

  async function handleAsk(e) {
    e.preventDefault();

    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || sending) return;

    const tempUserMessage = {
      id: `temp-user-${Date.now()}`,
      role: "user",
      content: trimmedQuestion,
    };

    const tempAssistantMessage = {
      id: STREAMING_MESSAGE_ID,
      role: "assistant",
      content: "Starting analysis…",
    };

    setMessages((prev) => [...prev, tempUserMessage, tempAssistantMessage]);
    setQuestion("");
    setHasStartedChat(true);

    abortStreamingIfAny();
    setStreamingProgress(0);
    setStreamingProgressTarget(0);

    const controller = new AbortController();
    streamControllerRef.current = controller;

    setSending(true);

    try {
      const response = await fetch("/api/chat/ask", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({
          conversationId: selectedConversationId,
          question: trimmedQuestion,
          useRag,
        }),
        signal: controller.signal,
      });

      if (!response.body) {
        throw new Error("No response body received from server.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      let shouldStop = false;

      const handleSseEvent = (eventName, rawData) => {
        const payload = rawData ? safeJsonParse(rawData) : null;

        // 1) Status updates from ask.js: { message, progress }
        if (eventName === "status" && payload) {
          if (payload.message) {
            upsertStreamingStatusMessage(payload.message);
          }
          if (payload.progress != null) {
            bumpStreamingProgressTarget(payload.progress);
          }
          return;
        }

        // 2) Dedicated progress updates from ask.js: { progress }
        if (eventName === "progress" && payload) {
          if (payload.progress != null) {
            bumpStreamingProgressTarget(payload.progress);
          }
          return;
        }

        // 3) Final: replace temp messages with server messages and update meta.
        if (eventName === "final" && payload) {
          shouldStop = true;
          streamControllerRef.current = null;
          setStreamingProgress(null);
          setStreamingProgressTarget(null);

          const convId = payload.conversationId || selectedConversationId;
          const serverMessages = Array.isArray(payload.messages)
            ? payload.messages
            : [];

          setSelectedConversationId(convId);
          setMessages(serverMessages);

          const rebuiltMeta = buildAnswerMetaByMessage(serverMessages, convId);
          setAnswerMetaByMessageId(rebuiltMeta);

          const finalPayload = getAnswerPayloadFromApiResponse(payload);
          setActiveAnswerPayload(finalPayload);

          setActiveAnswerMeta(
            finalPayload
              ? {
                  conversationId: convId,
                  sql: finalPayload?.meta?.sql ?? null,
                  table: finalPayload?.table ?? null,
                  tokens: finalPayload?.meta?.tokens ?? null,
                  rag: finalPayload?.meta?.rag ?? null,
                }
              : null
          );

          fetchConversations();
          if (convId) fetchStats(convId);
          return;
        }

        // 4) Error
        if (eventName === "error") {
          shouldStop = true;
          streamControllerRef.current = null;
          setStreamingProgress(null);
          setStreamingProgressTarget(null);

          const message =
            payload?.message || "Unable to process your request right now.";

          replaceStreamingWithError(message);
          setActiveAnswerMeta(null);
          setActiveAnswerPayload(null);
          return;
        }
      };

      const processBuffer = () => {
        let boundary = buffer.indexOf("\n\n");

        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          const { eventName, data } = parseSseEvent(rawEvent);
          handleSseEvent(eventName, data);

          if (shouldStop) break;

          boundary = buffer.indexOf("\n\n");
        }
      };

      // Stream loop
      while (!shouldStop) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder
          .decode(value, { stream: true })
          .replace(/\r\n/g, "\n");
        processBuffer();

        if (shouldStop) break;
      }

      // Flush any remaining buffered content
      buffer += decoder.decode().replace(/\r\n/g, "\n");
      processBuffer();

      // If the stream ends unexpectedly without a final event
      if (!shouldStop) {
        console.error("SSE connection closed before final event.");

        replaceStreamingWithError("Connection closed unexpectedly.");
        setActiveAnswerMeta(null);
        setActiveAnswerPayload(null);
      }
    } catch (err) {
      if (err.name === "AbortError") {
        console.warn("Cancelled in-flight request.");
      } else {
        console.error("Error sending question:", err);
        setStreamingProgress(null);
        setStreamingProgressTarget(null);
        replaceStreamingWithError("Unable to process your request.");
      }
    } finally {
      setSending(false);
      streamControllerRef.current = null;
    }
  }

  // -----------------------------
  // Stats modal open/close
  // -----------------------------

  function handleOpenStatsForMessage(msg) {
    if (!selectedConversationId) return;

    setActiveAnswer(msg);

    const meta = answerMetaByMessageId[msg.id];

    // If we don't have per-message meta yet (e.g., older answers),
    // keep whatever active meta we already have as a fallback.
    setActiveAnswerMeta((prev) => meta || prev);
    setActiveAnswerPayload((prev) => meta?.answerPayload || prev);

    // Ensure latest stats for this conversation
    fetchStats(selectedConversationId);

    setIsStatsModalOpen(true);
  }

  function handleCloseStatsModal() {
    setIsStatsModalOpen(false);
    setActiveAnswer(null);
    setShowAdvancedStats(false);
    setActiveAnswerPayload(null);
  }

  // -----------------------------
  // Message rendering helpers
  // -----------------------------

  function InlineResults({ messageId }) {
    const payload = answerMetaByMessageId?.[messageId]?.answerPayload;

    if (!payload) return null;
    if (!showInlineVisuals) return null;

    const table = payload?.table;
    const columns = table?.columns || [];
    const rows = table?.rows || [];

    const hasTable = rows.length > 0 && columns.length > 0;
    if (!hasTable) return null;

    return (
      <div className="mt-2 rounded-md border border-neutral-200 bg-white">
        <div className="flex items-center justify-between border-b border-neutral-100 px-3 py-2">
          <div className="text-[12px] font-semibold text-neutral-800">
            Results
          </div>
          <div className="flex items-center gap-2">
            {table?.truncated ? (
              <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                Preview truncated
              </span>
            ) : null}

            {payload?.downloads?.some((d) => d?.kind === "csv") ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 border-neutral-300 text-neutral-700 hover:bg-neutral-100"
                onClick={(e) => {
                  e.stopPropagation();
                  downloadCsvFromPayload(payload);
                }}
              >
                <Download className="mr-1 h-3.5 w-3.5" />
                CSV
              </Button>
            ) : null}
          </div>
        </div>

        {rows.length > 100 ? (
          <VirtualTable columns={columns} rows={rows} maxHeight={320} />
        ) : (
          <div className="max-h-80 overflow-auto">
            <table className="min-w-full border-collapse text-[12px]">
              <thead className="sticky top-0 z-10 bg-neutral-50">
                <tr>
                  {columns.map((col) => (
                    <th
                      key={col}
                      className="px-2 py-1 text-left font-medium text-neutral-700"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr
                    key={idx}
                    className={idx % 2 === 0 ? "bg-white" : "bg-neutral-50"}
                  >
                    {columns.map((col) => (
                      <td
                        key={col}
                        className="px-2 py-1 whitespace-nowrap font-mono text-[10px] text-neutral-800"
                      >
                        {formatCellValue(row?.[col])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="border-t border-neutral-100 px-3 py-2 text-[10px] text-neutral-600">
          Rows returned:{" "}
          {table?.rowCount?.toLocaleString?.() ||
            table?.rowCount ||
            rows.length}
        </div>
      </div>
    );
  }

  function AnswerActions({ messageId }) {
    const rating = feedbackByMessageId?.[messageId]?.rating;

    return (
      <div className="mt-2 flex items-center gap-1 text-[10px]">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={`h-7 w-7 border-none bg-neutral-100 shadow-none text-neutral-400 hover:bg-neutral-100 ${
            rating === "up" ? "bg-neutral-100" : ""
          }`}
          onClick={(e) => {
            e.stopPropagation();
            submitThumbsUp(messageId);
          }}
          title="Thumbs up"
          aria-label="Thumbs up"
        >
          <ThumbsUp className="h-3.5 w-3.5" />
        </Button>

        <Button
          type="button"
          variant="outline"
          size="icon"
          className={`h-7 w-7 border-none bg-neutral-100 shadow-none text-neutral-400 hover:bg-neutral-100 ${
            rating === "down" ? "bg-neutral-100" : ""
          }`}
          onClick={(e) => {
            e.stopPropagation();
            openFeedbackModalForMessage(messageId);
          }}
          title="Thumbs down"
          aria-label="Thumbs down"
        >
          <ThumbsDown className="h-3.5 w-3.5" />
        </Button>

        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-7 w-7 border-none bg-neutral-100 shadow-none text-neutral-400 hover:bg-neutral-100"
          onClick={(e) => {
            e.stopPropagation();
            copyMessageToClipboard(messageId);
          }}
          title="Copy answer + data"
          aria-label="Copy answer + data"
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>

        {copyStatusByMessageId?.[messageId] === "copied" ? (
          <span className="ml-2 text-[10px] text-neutral-500">Copied</span>
        ) : null}

        {feedbackToastByMessageId?.[messageId] ? (
          <span className="ml-2 text-[10px] text-neutral-500">
            {feedbackToastByMessageId[messageId] === "up"
              ? "Saved"
              : "Feedback sent"}
          </span>
        ) : null}
      </div>
    );
  }

  // -----------------------------
  // Render
  // -----------------------------

  const hasConversations = conversations.length > 0;
  const isChatStarted = hasStartedChat || !!selectedConversationId;
  return (
    <div
      className={`${geistSans.className} ${geistMono.className} flex h-screen bg-neutral-100 font-sans dark:bg-black`}
    >
      {/* Sidebar */}
      <aside className="flex h-screen w-72 flex-col border-r border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
              Retail AI Analyst
            </h1>
            <div className="text-sm font-light text-slate-400">
              {tenant.name}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between px-2 pt-3 pb-2">
          <Button
            size="sm"
            className="h-10 w-full bg-red-800 text-[12px] text-white hover:bg-red-400"
            onClick={handleNewConversation}
          >
            Start New Analysis
          </Button>
        </div>

        <div className="flex-1 overflow-hidden px-2 pb-4 pt-8">
          <Card className="h-full border-none shadow-none">
            <CardContent className="h-full p-0">
              <div className="flex h-full max-h-full flex-col divide-y divide-neutral-100 overflow-y-auto">
                {loadingConversations && (
                  <div className="p-3 text-xs text-neutral-500">
                    Loading conversations…
                  </div>
                )}
                {!loadingConversations && conversations.length === 0 && (
                  <div className="p-3 text-xs text-neutral-500">
                    No conversations yet. Ask your first question.
                  </div>
                )}
                {conversations.map((conv) => (
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => handleSelectConversation(conv.id)}
                    className={`flex w-full flex-col items-start px-3 py-2 text-left text-xs transition ${
                      selectedConversationId === conv.id
                        ? "bg-red-50 text-red-500 rounded-xs"
                        : "hover:bg-neutral-100"
                    }`}
                  >
                    <span className="line-clamp-1 font-medium">
                      {conv.title || "Untitled conversation"}
                    </span>
                    {conv.last_message && (
                      <span
                        className={`mt-0.5 line-clamp-2 ${
                          selectedConversationId === conv.id
                            ? "text-neutral-400"
                            : "text-neutral-500"
                        }`}
                      >
                        {conv.last_message}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="mt-auto px-4 pb-4">
          <div className="flex items-center justify-between gap-2">
            <div className="max-w-[70%] truncate text-xs text-neutral-600">
              {user?.name || user?.email}
            </div>
            <div className="relative">
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-8 w-8 border-none shadow-none text-neutral-700 hover:bg-neutral-100"
                onClick={() => setIsSettingsOpen((prev) => !prev)}
              >
                <Settings className="h-4 w-4" />
              </Button>

              {isSettingsOpen && (
                <div className="absolute bottom-10 right-0 w-40 rounded-md border border-neutral-200 bg-white shadow-lg text-xs">
                  <button
                    type="button"
                    className="block w-full px-3 py-2 text-left text-neutral-700 hover:bg-neutral-100"
                    onClick={openSettingsModal}
                  >
                    Settings
                  </button>
                  <button
                    type="button"
                    className="block w-full px-3 py-2 text-left text-neutral-700 hover:bg-neutral-100"
                    onClick={openUsageStats}
                  >
                    Usage stats
                  </button>
                  <div>
                    <button
                      type="submit"
                      className="block w-full px-3 py-2 text-left text-red-600 hover:bg-neutral-100 border-t border-neutral-200"
                      onClick={handleLogout}
                    >
                      Logout
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex flex-1 flex-col pl-8 pb-0 -mt-8  pt-0 overflow-hidden">
        {isChatStarted ? (
          <section className="flex flex-1 min-h-0 flex-col gap-3">
            {/* Chat area */}
            <Card className="flex flex-1 flex-col min-h-0 bg-neutral-100 border-none shadow-none ">
              <CardHeader className="border-b border-neutral-100 pb-2">
                <CardTitle className="text-md font-medium text-neutral-800">
                  {/*Ask a question*/}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-1 min-h-0 flex-col p-0">
                {/* Messages */}
                <div className="flex-1 min-h-0 space-y-4 overflow-y-auto p-3 text-md pr-8">
                  {loadingMessages && (
                    <p className="text-xs text-neutral-500">
                      Loading messages…
                    </p>
                  )}
                  {!loadingMessages && messages.length === 0 && (
                    <p className="text-xs text-neutral-500">
                      Start a new conversation or pick an existing one.
                    </p>
                  )}

                  {messages.map((msg) => {
                    const isUser = msg.role === "user";
                    return (
                      <div
                        key={msg.id}
                        className={`flex ${
                          isUser ? "justify-end" : "justify-start"
                        }`}
                      >
                        {isUser ? (
                          <div className="max-w-[75%] rounded-md bg-neutral-400 px-3 py-2 text-xs leading-relaxed text-neutral-50">
                            {msg.content}
                          </div>
                        ) : (
                          <div className="w-full max-w-[75%] mb-3">
                            {/* Answer bubble */}
                            <div
                              className="rounded-md border border-neutral-200 bg-white px-3 py-2 text-xs leading-relaxed text-neutral-800 cursor-pointer hover:bg-neutral-50"
                              onClick={() => handleOpenStatsForMessage(msg)}
                            >
                              <div>{msg.content}</div>

                              {msg.id === STREAMING_MESSAGE_ID &&
                              typeof streamingProgress === "number" ? (
                                <div
                                  className="mt-2 h-1 w-full overflow-hidden rounded bg-neutral-200"
                                  aria-label="Progress"
                                  role="progressbar"
                                  aria-valuenow={Math.round(streamingProgress)}
                                  aria-valuemin={0}
                                  aria-valuemax={100}
                                >
                                  <div
                                    className="h-full bg-neutral-700 transition-[width] duration-300"
                                    style={{
                                      width: `${Math.max(
                                        2,
                                        streamingProgress
                                      )}%`,
                                    }}
                                  />
                                </div>
                              ) : null}
                            </div>

                            {/* Inline BI rendering (stacked) */}
                            {(() => {
                              const payload =
                                answerMetaByMessageId?.[msg.id]?.answerPayload;
                              const table = payload?.table;
                              const columns = table?.columns || [];
                              const rows = table?.rows || [];
                              const hasTable =
                                rows.length > 0 && columns.length > 0;

                              if (!payload) return null;
                              if (!showInlineVisuals) return null;

                              if (hasTable) {
                                return (
                                  <div className="mt-2 rounded-md border border-neutral-200 bg-white">
                                    <div className="flex items-center justify-between border-b border-neutral-100 px-3 py-2">
                                      <div className="text-[12px] font-semibold text-neutral-800">
                                        Results
                                      </div>
                                      <div className="flex items-center gap-2">
                                        {table?.truncated ? (
                                          <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                                            Preview truncated
                                          </span>
                                        ) : null}

                                        {payload?.downloads?.some(
                                          (d) => d?.kind === "csv"
                                        ) ? (
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            className="h-7 border-neutral-300 text-neutral-700 hover:bg-neutral-100"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              downloadCsvFromPayload(payload);
                                            }}
                                          >
                                            <Download className="mr-1 h-3.5 w-3.5" />
                                            CSV
                                          </Button>
                                        ) : null}
                                      </div>
                                    </div>

                                    {rows.length > 100 ? (
                                      <VirtualTable
                                        columns={columns}
                                        rows={rows}
                                        maxHeight={320}
                                      />
                                    ) : (
                                      <div className="max-h-80 overflow-auto">
                                        <table className="min-w-full border-collapse text-[12px]">
                                          <thead className="sticky top-0 z-10 bg-neutral-50">
                                            <tr>
                                              {columns.map((col) => (
                                                <th
                                                  key={col}
                                                  className="px-2 py-1 text-left font-medium text-neutral-700"
                                                >
                                                  {col}
                                                </th>
                                              ))}
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {rows.map((row, idx) => (
                                              <tr
                                                key={idx}
                                                className={
                                                  idx % 2 === 0
                                                    ? "bg-white"
                                                    : "bg-neutral-50"
                                                }
                                              >
                                                {columns.map((col) => (
                                                  <td
                                                    key={col}
                                                    className="px-2 py-1 whitespace-nowrap font-mono text-[10px] text-neutral-800"
                                                  >
                                                    {formatCellValue(
                                                      row?.[col]
                                                    )}
                                                  </td>
                                                ))}
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}

                                    <div className="border-t border-neutral-100 px-3 py-2 text-[10px] text-neutral-600">
                                      Rows returned:{" "}
                                      {table?.rowCount?.toLocaleString?.() ||
                                        table?.rowCount ||
                                        rows.length}
                                    </div>
                                  </div>
                                );
                              }

                              return null;
                            })()}

                            {/* Inline chart rendering (stacked under Results) */}
                            {(() => {
                              const payload =
                                answerMetaByMessageId?.[msg.id]?.answerPayload;

                              if (!payload) return null;
                              if (!showInlineVisuals) return null;
                              if (!isClient) return null;

                              const chart = payload?.chart;
                              if (!chart || chart.type !== "basicareachart") {
                                return null;
                              }

                              const xKey = chart?.xKey;
                              const yKey = chart?.yKey;
                              const data = Array.isArray(chart?.data)
                                ? chart.data
                                : [];

                              if (!xKey || !yKey || data.length === 0)
                                return null;

                              return (
                                <div className="mt-2 rounded-md border border-neutral-200 bg-white">
                                  <div className="flex items-center justify-between border-b border-neutral-100 px-3 py-2">
                                    <div className="text-[12px] font-semibold text-neutral-800">
                                      Trend
                                    </div>
                                    <div className="text-[10px] text-neutral-500">
                                      {yKey} over {xKey}
                                    </div>
                                  </div>

                                  <div className="h-56 w-full px-2 py-2">
                                    <BasicAreaChartInner
                                      data={data}
                                      xKey={xKey}
                                      yKey={yKey}
                                    />
                                  </div>
                                </div>
                              );
                            })()}

                            {/* Answer actions */}
                            <div className="mt-2 flex items-center gap-1 text-[10px]">
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className={`h-7 w-7 border-none bg-neutral-100 shadow-none text-neutral-400 hover:bg-neutral-100 ${
                                  feedbackByMessageId?.[msg.id]?.rating === "up"
                                    ? "bg-neutral-100"
                                    : ""
                                }`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  submitThumbsUp(msg.id);
                                }}
                                title="Thumbs up"
                                aria-label="Thumbs up"
                              >
                                <ThumbsUp className="h-3.5 w-3.5" />
                              </Button>

                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className={`h-7 w-7 border-none bg-neutral-100 shadow-none text-neutral-400 hover:bg-neutral-100 ${
                                  feedbackByMessageId?.[msg.id]?.rating ===
                                  "down"
                                    ? "bg-neutral-100"
                                    : ""
                                }`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openFeedbackModalForMessage(msg.id);
                                }}
                                title="Thumbs down"
                                aria-label="Thumbs down"
                              >
                                <ThumbsDown className="h-3.5 w-3.5" />
                              </Button>

                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="h-7 w-7 border-none bg-neutral-100 shadow-none text-neutral-400 hover:bg-neutral-100"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  copyMessageToClipboard(msg.id);
                                }}
                                title="Copy answer + data"
                                aria-label="Copy answer + data"
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </Button>

                              {copyStatusByMessageId?.[msg.id] === "copied" ? (
                                <span className="ml-2 text-[10px] text-neutral-500">
                                  Copied
                                </span>
                              ) : null}

                              {feedbackToastByMessageId?.[msg.id] ? (
                                <span className="ml-2 text-[10px] text-neutral-500">
                                  {feedbackToastByMessageId[msg.id] === "up"
                                    ? "Saved"
                                    : "Feedback sent"}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <form
                  onSubmit={handleAsk}
                  className="border-t border-neutral-300 p-3 -ml-8 bg-white"
                >
                  <div className="flex gap-2 mr-8">
                    <Input
                      placeholder="Ask about your data, metrics, trends…"
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      disabled={sending}
                      className="bg-neutral-50 ml-8 text-md focus-visible:ring-neutral-500"
                    />
                    <Button
                      type="submit"
                      disabled={sending || !question.trim()}
                      className="bg-red-300 text-zinc-700 hover:bg-red-400 text-[12px]"
                    >
                      {sending ? "Asking…" : "Ask"}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          </section>
        ) : (
          <section className="flex flex-1 items-center justify-center -mt-32">
            <Card className="w-full max-w-4xl border-none shadow-none bg-gray-100">
              <CardHeader>
                <CardTitle className="text-md font-medium text-neutral-800"></CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleAsk} className="space-y-3">
                  <div className="flex gap-2">
                    <Input
                      placeholder="Ask anything about your data…"
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      disabled={sending}
                      className="bg-neutral-50 text-md h-14 flex-1 focus-visible:ring-neutral-500"
                    />
                    <Button
                      type="submit"
                      disabled={sending || !question.trim()}
                      className="bg-neutral-900 text-neutral-50 hover:bg-neutral-800 h-14 px-6"
                    >
                      {sending ? "Asking…" : "Ask"}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          </section>
        )}
      </main>

      {/* Settings modal */}
      {isSettingsModalOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg border border-neutral-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
              <h2 className="text-md font-medium text-neutral-900">Settings</h2>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-neutral-300 text-neutral-700 hover:bg-neutral-100"
                onClick={() => setIsSettingsModalOpen(false)}
              >
                Close
              </Button>
            </div>
            <div className="space-y-4 px-4 py-4 text-xs">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[12px] font-semibold text-neutral-800">
                    Use business context (RAG)
                  </div>
                  <div className="text-[12px] text-neutral-600">
                    When enabled, your questions are enriched with schema and
                    business documentation from the vector database.
                  </div>
                </div>
                <label className="ml-4 inline-flex items-center gap-2 text-[12px] text-neutral-700">
                  <input
                    type="checkbox"
                    className="h-3 w-3"
                    checked={useRag}
                    onChange={(e) => setUseRag(e.target.checked)}
                  />
                  <span>Enabled</span>
                </label>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[12px] font-semibold text-neutral-800">
                    Show tables inline
                  </div>
                  <div className="text-[12px] text-neutral-600">
                    When enabled, query result tables appear directly under each
                    AI answer.
                  </div>
                </div>
                <label className="ml-4 inline-flex items-center gap-2 text-[12px] text-neutral-700">
                  <input
                    type="checkbox"
                    className="h-3 w-3"
                    checked={showInlineVisuals}
                    onChange={(e) => setShowInlineVisuals(e.target.checked)}
                  />
                  <span>Enabled</span>
                </label>
              </div>

              <div className="space-y-2">
                <div className="text-[12px] font-semibold text-neutral-800">
                  User memory summary
                </div>
                <div className="text-[12px] text-neutral-600">
                  This is the long-term memory summary the system uses to
                  understand your role, preferences, and recurring goals. You
                  can edit it to override or refine what the AI has learned.
                </div>
                {userMemoryError && (
                  <p className="text-[12px] text-red-600">{userMemoryError}</p>
                )}
                <textarea
                  className="mt-1 h-40 w-full rounded-md border border-neutral-200 bg-neutral-50 p-2 text-[12px] leading-relaxed text-neutral-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
                  value={userMemorySummary}
                  onChange={(e) => setUserMemorySummary(e.target.value)}
                  placeholder="Describe your role, the metrics you care about, and any stable preferences you want the system to remember…"
                />
                <div className="mt-2 flex items-center justify-between">
                  {loadingUserMemory ? (
                    <span className="text-[12px] text-neutral-500">
                      Loading current memory…
                    </span>
                  ) : (
                    <span className="text-[12px] text-neutral-500">
                      This summary is stored with your account and used across
                      conversations.
                    </span>
                  )}
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    className="bg-neutral-900 text-neutral-50 hover:bg-neutral-800"
                    onClick={saveUserMemory}
                    disabled={savingUserMemory}
                  >
                    {savingUserMemory ? "Saving…" : "Save changes"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Feedback (thumbs down) modal */}
      {isFeedbackModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-lg rounded-lg border border-neutral-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
              <div>
                <h2 className="text-md font-medium text-neutral-900">
                  Report an issue with this answer
                </h2>
                {feedbackTarget?.messageId ? (
                  <p className="mt-1 line-clamp-2 text-xs text-neutral-500">
                    Message ID: {feedbackTarget.messageId}
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-neutral-300 text-neutral-700 hover:bg-neutral-100"
                onClick={() => {
                  setIsFeedbackModalOpen(false);
                  setFeedbackTarget(null);
                  setFeedbackText("");
                }}
                disabled={feedbackSubmitting}
              >
                Close
              </Button>
            </div>

            <div className="space-y-3 px-4 py-4 text-xs">
              <div>
                <div className="text-[12px] font-semibold text-neutral-800">
                  What went wrong? (optional)
                </div>
                <div className="mt-1 text-[12px] text-neutral-600">
                  If you add context, we can improve future answers.
                </div>
                <textarea
                  className="mt-2 h-28 w-full rounded-md border border-neutral-200 bg-neutral-50 p-2 text-[12px] leading-relaxed text-neutral-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                  placeholder="E.g., wrong date range, wrong filters, should be grouped by store, etc."
                  disabled={feedbackSubmitting}
                />
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="border-neutral-300 text-neutral-700 hover:bg-neutral-100"
                  onClick={() => {
                    setIsFeedbackModalOpen(false);
                    setFeedbackTarget(null);
                    setFeedbackText("");
                  }}
                  disabled={feedbackSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="bg-neutral-900 text-neutral-50 hover:bg-neutral-800"
                  onClick={submitThumbsDown}
                  disabled={feedbackSubmitting}
                >
                  {feedbackSubmitting ? "Submitting…" : "Submit"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Usage stats modal */}
      {isUsageModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-3xl rounded-lg border border-neutral-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
              <h2 className="text-md font-medium text-neutral-900">
                Usage statistics
              </h2>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-neutral-300 text-neutral-700 hover:bg-neutral-100"
                onClick={() => setIsUsageModalOpen(false)}
              >
                Close
              </Button>
            </div>
            <div className="space-y-4 px-4 py-4 text-xs">
              {usageLoading ? (
                <p className="text-neutral-500">Loading usage stats…</p>
              ) : (
                <>
                  {/* Summary widgets */}
                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3">
                      <div className="text-[12px] font-semibold uppercase tracking-wide text-neutral-500">
                        Lifetime tokens
                      </div>
                      <div className="mt-1 text-lg font-semibold text-neutral-900">
                        {usageSummary.lifetimeTotalTokens.toLocaleString()}
                      </div>
                    </div>
                    <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3">
                      <div className="text-[12px] font-semibold uppercase tracking-wide text-neutral-500">
                        This month
                      </div>
                      <div className="mt-1 text-lg font-semibold text-neutral-900">
                        {usageSummary.monthTotalTokens.toLocaleString()}
                      </div>
                    </div>
                    <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3">
                      <div className="text-[12px] font-semibold uppercase tracking-wide text-neutral-500">
                        This week
                      </div>
                      <div className="mt-1 text-lg font-semibold text-neutral-900">
                        {usageSummary.weekTotalTokens.toLocaleString()}
                      </div>
                    </div>
                  </div>

                  {/* Daily chart (simple bar chart) */}
                  <div>
                    <div className="mb-1 text-[12px] font-semibold text-neutral-700">
                      Daily token usage (last 30 days)
                    </div>
                    {usageSummary.daily.length === 0 ? (
                      <p className="text-[12px] text-neutral-500">
                        No usage recorded yet.
                      </p>
                    ) : (
                      <>
                        <div className="relative flex h-32 items-end gap-[2px] rounded-md border border-neutral-200 bg-neutral-50 px-2 py-2">
                          {(() => {
                            // usageSummary.daily is already normalized in openUsageStats
                            // to have { date: string, totalTokens: number }.
                            console.log(usageSummary.daily);
                            if (!Array.isArray(usageSummary.daily)) return null;

                            const values = usageSummary.daily.map((d) =>
                              typeof d.totalTokens === "number"
                                ? d.totalTokens
                                : Number(d.totalTokens) || 0
                            );

                            const max = values.reduce(
                              (acc, v) => (v > acc ? v : acc),
                              0
                            );

                            const safeMax = max || 1; // avoid division by zero

                            return usageSummary.daily.map((d, idx) => {
                              const rawValue = d.totalTokens;
                              const value =
                                typeof rawValue === "number"
                                  ? rawValue
                                  : Number(rawValue) || 0;
                              const heightPct = Math.max(
                                2,
                                (value / safeMax) * 100
                              );

                              return (
                                <div
                                  key={`${d.date}-${idx}`}
                                  className="group relative flex-1 h-full"
                                  title={`${d.date}: ${value} tokens`}
                                >
                                  <div
                                    className="absolute bottom-0 w-full rounded-t-sm bg-neutral-400 transition-colors group-hover:bg-neutral-700"
                                    style={{ height: `${heightPct}%` }}
                                  />
                                </div>
                              );
                            });
                          })()}
                        </div>
                        <div className="mt-1 flex justify-between text-[9px] text-neutral-500">
                          <span>
                            {usageSummary.daily[0].date} –{" "}
                            {
                              usageSummary.daily[usageSummary.daily.length - 1]
                                .date
                            }
                          </span>
                          <span>Total tokens per day</span>
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Stats modal */}
      {isStatsModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-2xl max-h-[85vh] overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
              <div>
                <h2 className="text-md font-medium text-neutral-900">
                  SQL queries &amp; token usage
                </h2>
                {activeAnswer && (
                  <p className="mt-1 line-clamp-2 text-xs text-neutral-500">
                    For answer: {activeAnswer.content}
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-neutral-300 text-neutral-700 hover:bg-neutral-100"
                onClick={handleCloseStatsModal}
              >
                Close
              </Button>
            </div>

            <div
              className="space-y-4 px-4 py-3 text-xs overflow-y-auto"
              style={{ maxHeight: "calc(85vh - 56px)" }}
            >
              {!selectedConversationId ? (
                <p className="text-neutral-500">
                  No conversation selected. Close this and pick a conversation.
                </p>
              ) : (
                <>
                  {activeAnswerMeta && (
                    <div className="space-y-3 rounded-md border border-neutral-100 bg-neutral-50 px-3 py-3">
                      {activeAnswerMeta.sql && (
                        <div>
                          <div className="mb-1 text-[12px] font-semibold text-neutral-700">
                            SQL for this answer
                          </div>
                          <pre className="max-h-32 overflow-auto rounded-md bg-neutral-900 px-3 py-2 font-mono text-[10px] text-neutral-50">
                            {activeAnswerMeta.sql}
                          </pre>
                        </div>
                      )}
                      {activeAnswerMeta.tokens && (
                        <div className="text-[12px] text-neutral-700">
                          Tokens – model{" "}
                          <span className="font-mono">
                            {activeAnswerMeta.tokens.model}
                          </span>
                          , prompt {activeAnswerMeta.tokens.input}, completion{" "}
                          {activeAnswerMeta.tokens.output}, total{" "}
                          {activeAnswerMeta.tokens.total}
                        </div>
                      )}
                      {activeAnswerPayload?.table && (
                        <div className="text-[12px] text-neutral-700">
                          Rows returned:{" "}
                          {activeAnswerPayload.table.rowCount?.toLocaleString?.() ||
                            activeAnswerPayload.table.rowCount ||
                            0}
                          {activeAnswerPayload.table.truncated ? (
                            <span className="ml-2 rounded-sm bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                              Preview truncated
                            </span>
                          ) : null}
                        </div>
                      )}

                      {activeAnswerPayload?.downloads?.some(
                        (d) => d?.kind === "csv"
                      ) && (
                        <div className="flex items-center justify-between rounded-md border border-neutral-200 bg-white px-3 py-2">
                          <div>
                            <div className="text-[12px] font-semibold text-neutral-800">
                              Download
                            </div>
                            <div className="text-[10px] text-neutral-600">
                              Export the full result set as CSV.
                            </div>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            className="bg-neutral-900 text-neutral-50 hover:bg-neutral-800"
                            onClick={() =>
                              downloadCsvFromPayload(activeAnswerPayload)
                            }
                          >
                            <Download className="mr-1 h-3.5 w-3.5" />
                            CSV
                          </Button>
                        </div>
                      )}

                      {activeAnswerMeta.rag &&
                        activeAnswerMeta.rag.used &&
                        activeAnswerMeta.rag.sources &&
                        activeAnswerMeta.rag.sources.length > 0 && (
                          <div className="mt-2 space-y-1">
                            <div className="text-[12px] font-semibold text-neutral-700">
                              Source materials used for this answer (
                              {activeAnswerMeta.rag.sources.length})
                            </div>
                            <div className="max-h-32 space-y-1 overflow-auto rounded-md border border-neutral-200 bg-white px-2 py-2">
                              {activeAnswerMeta.rag.sources.map((src) => (
                                <div
                                  key={src.id}
                                  className="border-b border-neutral-100 pb-1 last:border-b-0 last:pb-0"
                                >
                                  <div className="text-[12px] font-medium text-neutral-800">
                                    {src.title}
                                  </div>
                                  <div className="text-[10px] text-neutral-600">
                                    {src.type && <span>{src.type}</span>}
                                    {src.table_name && (
                                      <span>
                                        {" "}
                                        · table: <code>{src.table_name}</code>
                                      </span>
                                    )}
                                    {src.page != null && (
                                      <span> · page {src.page}</span>
                                    )}
                                  </div>
                                  {src.snippet && (
                                    <div className="mt-0.5 line-clamp-2 text-[10px] text-neutral-700">
                                      {src.snippet}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      {activeAnswerMeta.table &&
                        activeAnswerMeta.table.columns &&
                        activeAnswerMeta.table.rows &&
                        activeAnswerMeta.table.rows.length > 0 && (
                          <div>
                            <div className="mb-1 text-[12px] font-semibold text-neutral-700">
                              Result preview for this answer (
                              {activeAnswerMeta.table.rows.length} rows)
                            </div>
                            {(() => {
                              const cols = activeAnswerMeta.table.columns || [];
                              const rws = activeAnswerMeta.table.rows || [];
                              const useVirtual = rws.length > 100;

                              if (useVirtual) {
                                return (
                                  <VirtualTable
                                    columns={cols}
                                    rows={rws}
                                    maxHeight={240}
                                  />
                                );
                              }

                              return (
                                <div className="max-h-40 overflow-auto rounded-md border border-neutral-200 bg-white">
                                  <table className="min-w-full border-collapse text-[12px]">
                                    <thead className="bg-neutral-50">
                                      <tr>
                                        {cols.map((col) => (
                                          <th
                                            key={col}
                                            className="px-2 py-1 text-left font-medium text-neutral-700"
                                          >
                                            {col}
                                          </th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {rws.map((row, idx) => (
                                        <tr
                                          key={idx}
                                          className={
                                            idx % 2 === 0
                                              ? "bg-white"
                                              : "bg-neutral-50"
                                          }
                                        >
                                          {cols.map((col) => (
                                            <td
                                              key={col}
                                              className="px-2 py-1 whitespace-nowrap font-mono text-[10px] text-neutral-800"
                                            >
                                              {row[col]}
                                            </td>
                                          ))}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              );
                            })()}
                          </div>
                        )}
                    </div>
                  )}

                  {/* More info toggle */}
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => setShowAdvancedStats((prev) => !prev)}
                      className="text-[12px] font-medium text-neutral-600 underline-offset-2 hover:underline"
                    >
                      {showAdvancedStats ? "Hide more info" : "More info"}
                    </button>
                  </div>

                  {showAdvancedStats && (
                    <>
                      {/* Recent SQL queries */}
                      <div>
                        <div className="mb-1 flex items-center justify-between">
                          <h3 className="text-xs font-semibold text-neutral-700">
                            Recent SQL queries
                          </h3>
                          {loadingStats && (
                            <span className="text-[10px] text-neutral-500">
                              Loading…
                            </span>
                          )}
                        </div>
                        {!loadingStats && stats.sqlQueries.length === 0 && (
                          <p className="text-neutral-500">
                            No SQL queries recorded yet.
                          </p>
                        )}
                        {!loadingStats && stats.sqlQueries.length > 0 && (
                          <div className="max-h-40 overflow-y-auto rounded-md border border-neutral-100">
                            <table className="w-full border-collapse text-[12px]">
                              <thead className="bg-neutral-50 text-neutral-500">
                                <tr>
                                  <th className="px-2 py-1 text-left font-medium">
                                    SQL
                                  </th>
                                  <th className="px-2 py-1 text-left font-medium">
                                    Status
                                  </th>
                                  <th className="px-2 py-1 text-right font-medium">
                                    Rows
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {stats.sqlQueries.map((q) => (
                                  <tr
                                    key={q.id}
                                    className="border-t border-neutral-100"
                                  >
                                    <td className="px-2 py-1 align-top">
                                      <span className="line-clamp-2 font-mono text-[10px]">
                                        {q.sql_text}
                                      </span>
                                    </td>
                                    <td className="px-2 py-1 align-top text-neutral-700">
                                      {q.status}
                                    </td>
                                    <td className="px-2 py-1 align-top text-right text-neutral-700">
                                      {q.rows_returned ?? "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>

                      {/* Recent token usage */}
                      <div>
                        <div className="mb-1 flex items-center justify-between">
                          <h3 className="text-xs font-semibold text-neutral-700">
                            Recent token usage
                          </h3>
                        </div>
                        {!loadingStats && stats.tokenUsage.length === 0 && (
                          <p className="text-neutral-500">
                            No token usage recorded yet.
                          </p>
                        )}
                        {!loadingStats && stats.tokenUsage.length > 0 && (
                          <div className="max-h-40 overflow-y-auto rounded-md border border-neutral-100">
                            <table className="w-full border-collapse text-[12px]">
                              <thead className="bg-neutral-50 text-neutral-500">
                                <tr>
                                  <th className="px-2 py-1 text-left font-medium">
                                    Model
                                  </th>
                                  <th className="px-2 py-1 text-right font-medium">
                                    Prompt
                                  </th>
                                  <th className="px-2 py-1 text-right font-medium">
                                    Completion
                                  </th>
                                  <th className="px-2 py-1 text-right font-medium">
                                    Total
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {stats.tokenUsage.map((t) => (
                                  <tr
                                    key={t.id}
                                    className="border-t border-neutral-100"
                                  >
                                    <td className="px-2 py-1 align-top text-neutral-700">
                                      {t.model || "—"}
                                    </td>
                                    <td className="px-2 py-1 align-top text-right text-neutral-700">
                                      {t.prompt_tokens ?? "—"}
                                    </td>
                                    <td className="px-2 py-1 align-top text-right text-neutral-700">
                                      {t.completion_tokens ?? "—"}
                                    </td>
                                    <td className="px-2 py-1 align-top text-right text-neutral-700">
                                      {t.total_tokens ?? "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default withAuth(MainPage);

/*
export async function getServerSideProps({ req }) {
  const user = await getUserFromRequest(req);

  if (!user) {
    return {
      redirect: {
        destination: "/",
        permanent: false,
      },
    };
  }

  return {
    props: {
      user: {
        id: user.id,
        email: user.email,
        name: user.name || null,
      },
    },
  };
}
*/
