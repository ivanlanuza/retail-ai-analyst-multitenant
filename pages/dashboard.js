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
  const [activeAnswer, setActiveAnswer] = useState(null);

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

  function handleSelectConversation(id) {
    setSelectedConversationId(id);
    fetchMessages(id);
    fetchStats(id);
  }

  function handleNewConversation() {
    setSelectedConversationId(null);
    setMessages([]);
    setQuestion("");
    setStats({ sqlQueries: [], tokenUsage: [] });
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
      setMessages(data.messages || []);
      setQuestion("");

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
    // ensure latest stats for this conversation
    fetchStats(selectedConversationId);
    setIsStatsModalOpen(true);
  }

  function handleCloseStatsModal() {
    setIsStatsModalOpen(false);
    setActiveAnswer(null);
  }

  const hasConversations = conversations.length > 0;
  const isChatStarted = !!selectedConversationId && messages.length > 0;
  return (
    <div
      className={`${geistSans.className} ${geistMono.className} flex min-h-screen bg-neutral-100 font-sans dark:bg-black`}
    >
      {/* Sidebar */}
      <aside className="flex w-72 flex-col border-r border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-sm font-semibold text-neutral-900">
              Retail AI Analyst
            </h1>
            <p className="mt-1 text-xs text-neutral-500">
              {user?.name || user?.email}
            </p>
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
          <div className="relative flex justify-end">
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
                  onClick={() => setIsSettingsOpen(false)}
                >
                  Settings
                </button>
                <button
                  type="button"
                  className="block w-full px-3 py-2 text-left text-neutral-700 hover:bg-neutral-100"
                  onClick={() => setIsSettingsOpen(false)}
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
      </aside>

      {/* Main content */}
      <main className="flex flex-1 flex-col pl-4 pr-8 py-4">
        {isChatStarted ? (
          <section className="flex flex-1 flex-col gap-3">
            {/* Chat area */}
            <Card className="flex min-h-[320px] flex-1 flex-col border-neutral-200 bg-white shadow-sm">
              <CardHeader className="border-b border-neutral-100 pb-2">
                <CardTitle className="text-sm font-medium text-neutral-800">
                  Ask a question
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col p-0">
                {/* Messages */}
                <div className="flex-1 space-y-2 overflow-y-auto p-3 text-sm">
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
