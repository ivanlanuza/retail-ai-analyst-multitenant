import { withAuth } from "@/lib/auth/withAuth";
import { useAuth } from "@/lib/auth/AuthContext";
import { Button } from "@/components/ui/button";

function MainPage() {
  const { user, tenant, logout } = useAuth();

  const handleLogout = () => {
    logout();
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Main</h1>
          <p className="text-sm text-muted-foreground">
            Signed in as {user.email}
          </p>
        </div>

        <Button onClick={handleLogout}>Logout</Button>
      </div>

      <div className="rounded-md border p-4 space-y-1">
        <p className="text-sm">
          Tenant:
          <span className="ml-2 font-medium">{tenant.slug}</span>
        </p>
        <p className="text-sm text-muted-foreground">User Role: {user.role}</p>
      </div>
    </div>
  );
}

export default withAuth(MainPage);
