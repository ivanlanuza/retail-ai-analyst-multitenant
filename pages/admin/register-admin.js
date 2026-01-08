import { useEffect, useState } from "react";
import { withSystemAdmin } from "@/lib/auth/withAuth";
import { getToken } from "@/lib/auth/clientAuth";

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function RegisterAdminPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("SYSTEM_ADMIN");
  const [tenantSlug, setTenantSlug] = useState("");

  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  // --------------------------------------------------
  // Load tenants (SYSTEM_ADMIN only endpoint)
  // --------------------------------------------------
  useEffect(() => {
    async function loadTenants() {
      try {
        const res = await fetch("/api/admin/tenants", {
          headers: {
            Authorization: `Bearer ${getToken()}`,
          },
        });
        if (!res.ok) return;
        const data = await res.json();
        //alert(JSON.stringify(data));
        setTenants(data);
        if (!data || data.length === 0) {
          // eslint-disable-next-line no-console
          console.warn("No tenants returned from /api/admin/tenants");
        }
      } catch {
        // silent fail; tenant selection will simply be empty
      }
    }

    loadTenants();
  }, []);

  // Reset tenant when role changes
  useEffect(() => {
    if (role !== "TENANT_ADMIN") {
      setTenantSlug("");
    }
  }, [role]);

  // --------------------------------------------------
  // Submit
  // --------------------------------------------------
  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const payload = {
        email,
        password,
        role,
      };

      if (role === "TENANT_ADMIN") {
        payload.tenantSlug = tenantSlug;
      }

      const res = await fetch("/api/admin/register-admin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to create admin");
        return;
      }

      setSuccess("Admin created successfully");
      setPassword("");
    } catch {
      setError("Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Create Admin</CardTitle>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <p className="text-sm text-destructive">{error}</p>}
            {success && <p className="text-sm text-green-600">{success}</p>}

            <div className="space-y-1">
              <Label>Email</Label>
              <Input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="space-y-1">
              <Label>Temporary Password</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <div className="space-y-1">
              <Label>Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SYSTEM_ADMIN">System Admin</SelectItem>
                  <SelectItem value="TENANT_ADMIN">Tenant Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {role === "TENANT_ADMIN" && (
              <div className="space-y-1">
                <Label>Tenant</Label>
                <Select value={tenantSlug} onValueChange={setTenantSlug}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select tenant" />
                  </SelectTrigger>
                  <SelectContent>
                    {tenants.map((t) => (
                      <SelectItem key={t.slug} value={t.slug}>
                        {t.name} ({t.slug})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Creating..." : "Create Admin"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default withSystemAdmin(RegisterAdminPage);
