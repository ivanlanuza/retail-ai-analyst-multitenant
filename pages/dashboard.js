// pages/dashboard.js
import { getUserFromRequest } from "../lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default function DashboardPage({ user }) {
  return (
    <div className="min-h-screen px-4 py-8">
      <header className="mx-auto flex max-w-5xl items-center justify-between border-b border-neutral-200 pb-4">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">
            Retail AI Analyst
          </h1>
          <p className="text-sm text-neutral-500">
            Welcome back, {user?.name || user?.email}.
          </p>
        </div>
        <form method="POST" action="/api/auth/logout">
          <Button
            type="submit"
            variant="outline"
            className="border-neutral-300 text-neutral-700 hover:bg-neutral-100"
          >
            Logout
          </Button>
        </form>
      </header>

      <main className="mx-auto mt-8 max-w-5xl space-y-6">
        <Card className="border-neutral-200 bg-white shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg font-semibold text-neutral-900">
              Overview
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-neutral-600">
            <p>This is where we&apos;ll plug in:</p>
            <ul className="mt-2 list-disc pl-5 space-y-1">
              <li>Natural language → SQL engine</li>
              <li>Query history and token usage</li>
              <li>Saved dashboards and visualizations</li>
            </ul>
          </CardContent>
        </Card>
      </main>
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
