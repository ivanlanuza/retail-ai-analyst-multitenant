import { Geist, Geist_Mono } from "next/font/google";
import { useState } from "react";
import { useRouter } from "next/router";
import { useAuth } from "@/lib/auth/AuthContext";

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import Image from "next/image";
import { Sparkles, MessageSquare, Database, ShieldCheck } from "lucide-react";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export default function LoginPage() {
  const router = useRouter();

  const { login } = useAuth();

  const [tenantSlug, setTenantSlug] = useState("local");
  const [email, setEmail] = useState("ilanuza@iripple.com");
  const [password, setPassword] = useState("happycat");

  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantSlug,
          email,
          password,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Login failed");
        return;
      }
      login(data.token);
      router.push("/main");
    } catch (err) {
      setError("Unexpected error during login");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className={`${geistSans.className} ${geistMono.className} min-h-screen overflow-hidden`}
    >
      <div className="mx-auto flex min-h-screen  items-stretch">
        {/* LEFT: Marketing / Explanation */}
        <div className="relative flex w-full flex-col justify-center px-20 py-12 md:w-3/5">
          <div className="absolute inset-0 -z-10 bg-gradient-to-br from-primary/5 via-transparent to-primary/10" />
          <div className="pointer-events-none absolute -top-24 -left-24 h-72 w-72 rounded-full bg-red-300/20 blur-3xl" />
          <div className="pointer-events-none absolute bottom-[-6rem] right-[-4rem] h-96 w-96 rounded-full bg-red-200/20 blur-3xl" />
          <div className="space-y-6">
            <h1 className="text-3xl font-extrabold tracking-tight font-sans">
              Get instant answers from your business data
            </h1>

            <p className="text-base text-muted-foreground">
              Ask questions about your business in plain English and get instant
              answers from your own data — no SQL, no dashboards, no learning
              curve.
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-lg border bg-background p-4">
                <div className="mb-2 inline-flex rounded-md bg-red-100 p-2 text-red-600">
                  <MessageSquare size={18} />
                </div>
                <p className="font-medium">No technical skills required</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Just ask questions in plain English. No setup, no formulas, no
                  tools to learn.
                </p>
              </div>

              <div className="rounded-lg border bg-background p-4">
                <div className="mb-2 inline-flex rounded-md bg-red-100 p-2 text-red-600">
                  <Sparkles size={18} />
                </div>
                <p className="font-medium">Answers, not raw data</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Clear charts and short explanations that show what matters.
                </p>
              </div>

              <div className="rounded-lg border bg-background p-4">
                <div className="mb-2 inline-flex rounded-md bg-red-100 p-2 text-red-600">
                  <Database size={18} />
                </div>
                <p className="font-medium">Built on your own data</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Insights come directly from your database and stay ptotected
                  within your environment.
                </p>
              </div>

              <div className="rounded-lg border bg-background p-4">
                <div className="mb-2 inline-flex rounded-md bg-red-100 p-2 text-red-600">
                  <ShieldCheck size={18} />
                </div>
                <p className="font-medium">Learns how you work</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Adapts to your questions and preferences to deliver better
                  answers over time.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT: Login Card */}
        <div className="relative flex w-full items-center justify-center bg-background md:w-2/5">
          <div className="pointer-events-none absolute top-10  h-32  rounded-full bg-red-300/20 blur-2xl" />
          <Card className="w-full max-w-md rounded-2xl border bg-background/95 p-2 shadow-2xl backdrop-blur">
            <CardHeader>
              <div className="rounded-t-lg px-4 py-4 -mt-8 -mx-8 border-b bg-red-200">
                <CardTitle className="text-center text-md">
                  Sign in to your account
                </CardTitle>
              </div>
            </CardHeader>

            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && <p className="text-sm text-destructive">{error}</p>}

                <div className="space-y-1">
                  <Label>Account Name</Label>
                  <Input
                    value={tenantSlug}
                    onChange={(e) =>
                      setTenantSlug(e.target.value.toLowerCase())
                    }
                    placeholder="your-company"
                    required
                  />
                </div>

                <div className="space-y-1">
                  <Label>User Email</Label>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>

                <div className="space-y-1">
                  <Label>User Password</Label>
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>

                <Button className="w-full" disabled={loading}>
                  {loading ? "Signing in…" : "Login"}
                </Button>

                <p className="text-center text-xs text-muted-foreground">
                  {/*By signing in, you are accessing your organization’s private
                  analytics workspace.*/}
                </p>
                <div className="mt-12 rounded-xl border-l-4 border-red-400 bg-red-50/60 px-4 py-3">
                  <p className="text-sm italic text-muted-foreground">
                    “Think of it as talking to your database the same way you
                    talk to an analyst.”
                  </p>
                  <p className="mt-1 text-right text-xs font-medium text-muted-foreground">
                    — Natalie Portman
                  </p>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
