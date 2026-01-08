import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/router";

export default function Unauthorized() {
  const router = useRouter();

  return (
    <div className="flex h-screen items-center justify-center bg-muted">
      <Card className="w-[400px] text-center">
        <CardHeader>
          <CardTitle>403 — Unauthorized</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            You do not have permission to access this page.
          </p>
          <Button onClick={() => router.push("/")}>Go to Login</Button>
        </CardContent>
      </Card>
    </div>
  );
}
