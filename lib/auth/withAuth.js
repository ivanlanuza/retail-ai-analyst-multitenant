import { useEffect } from "react";
import { useRouter } from "next/router";
import { useAuth } from "./AuthContext";

export function withAuth(Component) {
  return function Protected(props) {
    const router = useRouter();
    const { user, initialized } = useAuth();

    useEffect(() => {
      // Do nothing until auth has initialized
      if (!initialized) return;

      // Once initialized, redirect only if not authenticated
      if (user === null) {
        router.replace("/");
      }
    }, [initialized, user]);

    // While initializing, render nothing
    if (!initialized) {
      return null;
    }

    // Initialized but not authenticated
    if (user === null) {
      return null;
    }

    return <Component {...props} />;
  };
}

export function withSystemAdmin(Component) {
  return function ProtectedAdmin(props) {
    const router = useRouter();
    const { user, initialized } = useAuth();

    useEffect(() => {
      if (!initialized) return;

      if (user === null) {
        router.replace("/");
        return;
      }

      if (user.role !== "SYSTEM_ADMIN") {
        router.replace("/unauthorized");
      }
    }, [initialized, user]);

    if (!initialized) return null;
    if (user === null) return null;
    if (user.role !== "SYSTEM_ADMIN") return null;

    return <Component {...props} />;
  };
}

export function withTenantAdmin(Component) {
  return function ProtectedTenantAdmin(props) {
    const router = useRouter();
    const { user, initialized } = useAuth();

    useEffect(() => {
      if (!initialized) return;

      if (user === null) {
        router.replace("/");
        return;
      }

      if (user.role !== "SYSTEM_ADMIN" && user.role !== "TENANT_ADMIN") {
        router.replace("/unauthorized");
      }
    }, [initialized, user]);

    if (!initialized) return null;
    if (user === null) return null;

    if (user.role !== "SYSTEM_ADMIN" && user.role !== "TENANT_ADMIN") {
      return null;
    }

    return <Component {...props} />;
  };
}
