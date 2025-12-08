// pages/register.js
import { useState } from "react";
import { useRouter } from "next/router";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({ email: "", password: "", name: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function handleChange(e) {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Registration failed");
        setLoading(false);
        return;
      }

      // On success, redirect to dashboard
      router.push("/dashboard");
    } catch (err) {
      console.error(err);
      setError("Unexpected error, please try again");
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <Card className="w-full max-w-md border-neutral-200 bg-white shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl font-semibold text-neutral-900">
            Add an account
          </CardTitle>
          <CardDescription className="text-neutral-500">
            Setup for Retail AI Analyst workspace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-1">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                name="name"
                placeholder="Juan Dela Cruz"
                value={form.name}
                onChange={handleChange}
                className="bg-neutral-50 focus-visible:ring-neutral-500"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="you@company.com"
                required
                value={form.email}
                onChange={handleChange}
                className="bg-neutral-50 focus-visible:ring-neutral-500"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                minLength={8}
                value={form.password}
                onChange={handleChange}
                className="bg-neutral-50 focus-visible:ring-neutral-500"
              />
              <p className="text-xs text-neutral-500">At least 8 characters.</p>
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                {error}
              </p>
            )}

            <Button
              type="submit"
              disabled={loading}
              className="w-full bg-neutral-900 text-neutral-50 hover:bg-neutral-800"
            >
              {loading ? "Creating account..." : "Sign up"}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="flex justify-between text-sm text-neutral-500">
          <span>Already have an account?</span>
          <button
            type="button"
            onClick={() => router.push("/")}
            className="text-neutral-900 underline-offset-4 hover:underline"
          >
            Log in
          </button>
        </CardFooter>
      </Card>
    </div>
  );
}
