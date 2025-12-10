// pages/dashboard.js
import { Geist, Geist_Mono } from "next/font/google";
import { useEffect, useState, useRef } from "react";
import { getUserFromRequest } from "../lib/auth";
import { Button } from "@/components/ui/button";
import { Settings } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export default function DashboardPage({ user }) {
  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState("");
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);

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
  const [activeAnswer, setActiveAnswer] = useState(null);
  const [answerMetaByMessageId, setAnswerMetaByMessageId] = useState({});
  const [activeAnswerMeta, setActiveAnswerMeta] = useState(null);
  const [showAdvancedStats, setShowAdvancedStats] = useState(false);
  const [useRag, setUseRag] = useState(true);
  // User memory editor state
  const [userMemorySummary, setUserMemorySummary] = useState("");
  const [loadingUserMemory, setLoadingUserMemory] = useState(false);
  const [savingUserMemory, setSavingUserMemory] = useState(false);
  const [userMemoryError, setUserMemoryError] = useState(null);

  const messagesEndRef = useRef(null);

  // Auto scroll to bottom when messages change
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Load conversations on mount
  useEffect(() => {
    fetchConversations();
  }, []);

  async function fetchConversations() {
    setLoadingConversations(true);
    try {
      const res = await fetch("/api/chat/conversations");
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
        `/api/chat/messages?conversationId=${conversationId}`
      );
      if (!res.ok) throw new Error("Failed to load messages");
      const data = await res.json();
      setMessages(data.messages || []);
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
        `/api/chat/stats?conversationId=${conversationId}`
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

  async function openUsageStats() {
    setIsSettingsOpen(false);
    setIsUsageModalOpen(true);
    setUsageLoading(true);

    try {
      const res = await fetch("/api/chat/usage");
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

  // Open settings modal and load user memory
  function openSettingsModal() {
    setIsSettingsOpen(false);
    setIsSettingsModalOpen(true);
    loadUserMemory();
  }

  async function loadUserMemory() {
    setLoadingUserMemory(true);
    setUserMemoryError(null);
    try {
      const res = await fetch("/api/user/memory");
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memorySummary: userMemorySummary }),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error(data.error || "Failed to save user memory");
        setUserMemoryError(data.error || "Failed to save user memory.");
        return;
      }
      // normalize summary from server in case it modified/trimmed it
      setUserMemorySummary(data.memorySummary || "");
    } catch (err) {
      console.error("Error saving user memory:", err);
      setUserMemoryError("Error saving user memory.");
    } finally {
      setSavingUserMemory(false);
    }
  }

  function handleSelectConversation(id) {
    setSelectedConversationId(id);
    setAnswerMetaByMessageId({});
    setActiveAnswerMeta(null);
    fetchMessages(id);
    fetchStats(id);
  }

  function handleNewConversation() {
    setSelectedConversationId(null);
    setMessages([]);
    setQuestion("");
    setStats({ sqlQueries: [], tokenUsage: [] });
    setAnswerMetaByMessageId({});
    setActiveAnswerMeta(null);
    setUseRag(true);
  }

  async function handleAsk(e) {
    e.preventDefault();
    if (!question.trim()) return;

    setSending(true);
    try {
      const res = await fetch("/api/chat/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: selectedConversationId,
          question: question.trim(),
          useRag,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        console.error(data.error || "Failed to send question");
        setSending(false);
        return;
      }

      // Update state with returned conversation + messages
      setSelectedConversationId(data.conversationId);
      const msgs = data.messages || [];
      setMessages(msgs);
      setQuestion("");

      // Store Phase 1 answer meta for the latest assistant message, keyed by message id
      if (
        data &&
        data.conversationId &&
        (data.sql || data.table || data.tokens)
      ) {
        const latestAssistant = [...msgs]
          .reverse()
          .find((m) => m.role === "assistant");
        if (latestAssistant) {
          const meta = {
            conversationId: data.conversationId,
            sql: data.sql || null,
            table: data.table || null,
            tokens: data.tokens || null,
            rag: data.rag || null,
          };
          setAnswerMetaByMessageId((prev) => ({
            ...prev,
            [latestAssistant.id]: meta,
          }));
          // also set as the currently active meta so it's immediately available
          setActiveAnswerMeta(meta);
        }
      }

      // Refresh conversations list so updated_at moves to top
      fetchConversations();
      // Refresh stats for this conversation
      fetchStats(data.conversationId);
    } catch (err) {
      console.error(err);
    } finally {
      setSending(false);
    }
  }

  function handleOpenStatsForMessage(msg) {
    if (!selectedConversationId) return;
    setActiveAnswer(msg);
    const meta = answerMetaByMessageId[msg.id];
    // if we don't have per-message meta yet (e.g., older answers),
    // keep whatever active meta we already have as a fallback
    setActiveAnswerMeta((prev) => meta || prev);
    // ensure latest stats for this conversation
    fetchStats(selectedConversationId);
    setIsStatsModalOpen(true);
  }

  function handleCloseStatsModal() {
    setIsStatsModalOpen(false);
    setActiveAnswer(null);
    setShowAdvancedStats(false);
  }

  const hasConversations = conversations.length > 0;
  const isChatStarted = !!selectedConversationId && messages.length > 0;
  return (
    <div
      className={`${geistSans.className} ${geistMono.className} flex h-screen bg-neutral-100 font-sans dark:bg-black`}
    >
      {/* Sidebar */}
      <aside className="flex h-screen w-72 flex-col border-r border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold tracking-tight text-neutral-900">
              Retail AI Analyst
            </h1>
          </div>
        </div>

        <div className="flex items-center justify-between px-2 pt-3 pb-2">
          <Button
            size="sm"
            className="h-10 w-full bg-neutral-900 text-[11px] text-neutral-50 hover:bg-neutral-800"
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
                        ? "bg-neutral-400 text-neutral-50 rounded-xs"
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
                            ? "text-neutral-200"
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
                  <form method="POST" action="/api/auth/logout">
                    <button
                      type="submit"
                      className="block w-full px-3 py-2 text-left text-red-600 hover:bg-neutral-100 border-t border-neutral-200"
                    >
                      Logout
                    </button>
                  </form>
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex flex-1 flex-col pl-4 pr-8 py-4 overflow-hidden">
        {isChatStarted ? (
          <section className="flex flex-1 min-h-0 flex-col gap-3">
            {/* Chat area */}
            <Card className="flex min-h-[320px] flex-1 min-h-0 flex-col border-neutral-200 bg-white shadow-sm">
              <CardHeader className="border-b border-neutral-100 pb-2">
                <CardTitle className="text-sm font-medium text-neutral-800">
                  Ask a question
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-1 min-h-0 flex-col p-0">
                {/* Messages */}
                <div className="flex-1 min-h-0 space-y-2 overflow-y-auto p-3 text-sm">
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
                        <div
                          className={`max-w-[75%] rounded-md px-3 py-2 text-xs leading-relaxed ${
                            isUser
                              ? "bg-neutral-400 text-neutral-50"
                              : "bg-neutral-100 text-neutral-800 cursor-pointer hover:bg-neutral-200"
                          }`}
                          onClick={
                            isUser
                              ? undefined
                              : () => handleOpenStatsForMessage(msg)
                          }
                        >
                          {msg.content}
                        </div>
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <form
                  onSubmit={handleAsk}
                  className="border-t border-neutral-100 p-3"
                >
                  <div className="flex gap-2">
                    <Input
                      placeholder="Ask about your data, metrics, trends…"
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      disabled={sending}
                      className="bg-neutral-50 text-sm focus-visible:ring-neutral-500"
                    />
                    <Button
                      type="submit"
                      disabled={sending || !question.trim()}
                      className="bg-neutral-900 text-neutral-50 hover:bg-neutral-800"
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
                <CardTitle className="text-sm font-medium text-neutral-800"></CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleAsk} className="space-y-3">
                  <div className="flex gap-2">
                    <Input
                      placeholder="Ask anything about your data…"
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      disabled={sending}
                      className="bg-neutral-50 text-sm h-14 flex-1 focus-visible:ring-neutral-500"
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
              <h2 className="text-sm font-medium text-neutral-900">Settings</h2>
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
                  <div className="text-[11px] font-semibold text-neutral-800">
                    Use business context (RAG)
                  </div>
                  <div className="text-[11px] text-neutral-600">
                    When enabled, your questions are enriched with schema and
                    business documentation from the vector database.
                  </div>
                </div>
                <label className="ml-4 inline-flex items-center gap-2 text-[11px] text-neutral-700">
                  <input
                    type="checkbox"
                    className="h-3 w-3"
                    checked={useRag}
                    onChange={(e) => setUseRag(e.target.checked)}
                  />
                  <span>Enabled</span>
                </label>
              </div>

              <div className="space-y-2">
                <div className="text-[11px] font-semibold text-neutral-800">
                  User memory summary
                </div>
                <div className="text-[11px] text-neutral-600">
                  This is the long-term memory summary the system uses to
                  understand your role, preferences, and recurring goals. You
                  can edit it to override or refine what the AI has learned.
                </div>
                {userMemoryError && (
                  <p className="text-[11px] text-red-600">{userMemoryError}</p>
                )}
                <textarea
                  className="mt-1 h-40 w-full rounded-md border border-neutral-200 bg-neutral-50 p-2 text-[11px] leading-relaxed text-neutral-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
                  value={userMemorySummary}
                  onChange={(e) => setUserMemorySummary(e.target.value)}
                  placeholder="Describe your role, the metrics you care about, and any stable preferences you want the system to remember…"
                />
                <div className="mt-2 flex items-center justify-between">
                  {loadingUserMemory ? (
                    <span className="text-[11px] text-neutral-500">
                      Loading current memory…
                    </span>
                  ) : (
                    <span className="text-[11px] text-neutral-500">
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

      {/* Usage stats modal */}
      {isUsageModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-3xl rounded-lg border border-neutral-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
              <h2 className="text-sm font-medium text-neutral-900">
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
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                        Lifetime tokens
                      </div>
                      <div className="mt-1 text-lg font-semibold text-neutral-900">
                        {usageSummary.lifetimeTotalTokens.toLocaleString()}
                      </div>
                    </div>
                    <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                        This month
                      </div>
                      <div className="mt-1 text-lg font-semibold text-neutral-900">
                        {usageSummary.monthTotalTokens.toLocaleString()}
                      </div>
                    </div>
                    <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                        This week
                      </div>
                      <div className="mt-1 text-lg font-semibold text-neutral-900">
                        {usageSummary.weekTotalTokens.toLocaleString()}
                      </div>
                    </div>
                  </div>

                  {/* Daily chart (simple bar chart) */}
                  <div>
                    <div className="mb-1 text-[11px] font-semibold text-neutral-700">
                      Daily token usage (last 30 days)
                    </div>
                    {usageSummary.daily.length === 0 ? (
                      <p className="text-[11px] text-neutral-500">
                        No usage recorded yet.
                      </p>
                    ) : (
                      <>
                        <div className="flex h-32 items-end gap-[2px] rounded-md border border-neutral-200 bg-neutral-50 px-2 py-2">
                          {(() => {
                            // usageSummary.daily is already normalized in openUsageStats
                            // to have { date: string, totalTokens: number }.
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
                                  className="group flex-1"
                                  title={`${d.date}: ${value} tokens`}
                                >
                                  <div
                                    className="w-full rounded-t-sm bg-neutral-400 transition-colors group-hover:bg-neutral-700"
                                    style={{
                                      height: `${heightPct}%`,
                                    }}
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
          <div className="w-full max-w-2xl rounded-lg border border-neutral-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
              <div>
                <h2 className="text-sm font-medium text-neutral-900">
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

            <div className="space-y-4 px-4 py-3 text-xs">
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
                          <div className="mb-1 text-[11px] font-semibold text-neutral-700">
                            SQL for this answer
                          </div>
                          <pre className="max-h-32 overflow-auto rounded-md bg-neutral-900 px-3 py-2 font-mono text-[10px] text-neutral-50">
                            {activeAnswerMeta.sql}
                          </pre>
                        </div>
                      )}
                      {activeAnswerMeta.tokens && (
                        <div className="text-[11px] text-neutral-700">
                          Tokens – model{" "}
                          <span className="font-mono">
                            {activeAnswerMeta.tokens.model}
                          </span>
                          , prompt {activeAnswerMeta.tokens.input}, completion{" "}
                          {activeAnswerMeta.tokens.output}, total{" "}
                          {activeAnswerMeta.tokens.total}
                        </div>
                      )}
                      {activeAnswerMeta.rag &&
                        activeAnswerMeta.rag.used &&
                        activeAnswerMeta.rag.sources &&
                        activeAnswerMeta.rag.sources.length > 0 && (
                          <div className="mt-2 space-y-1">
                            <div className="text-[11px] font-semibold text-neutral-700">
                              Source materials used for this answer (
                              {activeAnswerMeta.rag.sources.length})
                            </div>
                            <div className="max-h-32 space-y-1 overflow-auto rounded-md border border-neutral-200 bg-white px-2 py-2">
                              {activeAnswerMeta.rag.sources.map((src) => (
                                <div
                                  key={src.id}
                                  className="border-b border-neutral-100 pb-1 last:border-b-0 last:pb-0"
                                >
                                  <div className="text-[11px] font-medium text-neutral-800">
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
                            <div className="mb-1 text-[11px] font-semibold text-neutral-700">
                              Result preview for this answer (
                              {activeAnswerMeta.table.rows.length} rows)
                            </div>
                            <div className="max-h-40 overflow-auto rounded-md border border-neutral-200 bg-white">
                              <table className="min-w-full border-collapse text-[11px]">
                                <thead className="bg-neutral-50">
                                  <tr>
                                    {activeAnswerMeta.table.columns.map(
                                      (col) => (
                                        <th
                                          key={col}
                                          className="px-2 py-1 text-left font-medium text-neutral-700"
                                        >
                                          {col}
                                        </th>
                                      )
                                    )}
                                  </tr>
                                </thead>
                                <tbody>
                                  {activeAnswerMeta.table.rows.map(
                                    (row, idx) => (
                                      <tr
                                        key={idx}
                                        className={
                                          idx % 2 === 0
                                            ? "bg-white"
                                            : "bg-neutral-50"
                                        }
                                      >
                                        {activeAnswerMeta.table.columns.map(
                                          (col) => (
                                            <td
                                              key={col}
                                              className="px-2 py-1 whitespace-nowrap font-mono text-[10px] text-neutral-800"
                                            >
                                              {row[col]}
                                            </td>
                                          )
                                        )}
                                      </tr>
                                    )
                                  )}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                    </div>
                  )}

                  {/* More info toggle */}
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => setShowAdvancedStats((prev) => !prev)}
                      className="text-[11px] font-medium text-neutral-600 underline-offset-2 hover:underline"
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
                            <table className="w-full border-collapse text-[11px]">
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
                            <table className="w-full border-collapse text-[11px]">
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
