import { useEffect, useState } from "react";
import { withTenantAdmin } from "@/lib/auth/withAuth";
import { useAuth } from "@/lib/auth/AuthContext";
import { getToken } from "@/lib/auth/clientAuth";

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

function RegisterUserPage() {
  const { user } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [tenants, setTenants] = useState([]);
  const [tenantSlug, setTenantSlug] = useState("");

  const [loadingTenants, setLoadingTenants] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  const isSystemAdmin = user?.role === "SYSTEM_ADMIN";

  // --------------------------------------------------
  // Load tenants ONLY if SYSTEM_ADMIN
  // --------------------------------------------------
  useEffect(() => {
    if (!isSystemAdmin) return;

    async function loadTenants() {
      setLoadingTenants(true);
      try {
        const res = await fetch("/api/admin/tenants", {
          headers: {
            Authorization: `Bearer ${getToken()}`,
          },
        });
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || "Failed to load tenants");
        }

        setTenants(data);
        if (data.length > 0) {
          setTenantSlug(data[0].slug);
        }
      } catch (err) {
        setMessage(err.message);
      } finally {
        setLoadingTenants(false);
      }
    }

    loadTenants();
  }, [isSystemAdmin]);

  // --------------------------------------------------
  // Submit
  // --------------------------------------------------
  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    try {
      const payload = {
        email,
        password,
      };

      if (isSystemAdmin) {
        payload.tenantSlug = tenantSlug;
      }

      const res = await fetch("/api/admin/register-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        setMessage(data.error || "Failed to create user");
        return;
      }

      setMessage("User created successfully");
      setEmail("");
      setPassword("");
    } catch {
      setMessage("Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Create Tenant User</CardTitle>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {message && (
              <p className="text-sm text-muted-foreground">{message}</p>
            )}

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

            {isSystemAdmin && (
              <div className="space-y-1">
                <Label>Tenant</Label>
                <Select
                  value={tenantSlug}
                  onValueChange={setTenantSlug}
                  disabled={loadingTenants || tenants.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        loadingTenants ? "Loading tenants..." : "Select tenant"
                      }
                    />
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

            <Button
              type="submit"
              className="w-full"
              disabled={loading || (isSystemAdmin && !tenantSlug)}
            >
              {loading ? "Creating..." : "Create User"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default withTenantAdmin(RegisterUserPage);
