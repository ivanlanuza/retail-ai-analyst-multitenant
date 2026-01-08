import { createContext, useContext, useEffect, useState } from "react";
import { getUserFromToken } from "./clientAuth";
import { id } from "zod/v4/locales";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState({
    user: null,
    tenant: null,
    initialized: false,
  });

  // Initialize ONCE from localStorage
  useEffect(() => {
    const decoded = getUserFromToken();

    if (!decoded) {
      setAuth({
        user: null,
        tenant: null,
        initialized: true,
      });
      return;
    }

    setAuth({
      user: {
        id: decoded.userId,
        email: decoded.email,
        role: decoded.role,
      },
      tenant: {
        slug: decoded.tenantSlug,
        role: decoded.tenantRole,
        name: decoded.tenantName,
        id: decoded.tenantId,
      },
      initialized: true,
    });
  }, []);

  // Explicit login transition
  function login(token) {
    localStorage.setItem("token", token);

    const decoded = getUserFromToken();

    setAuth({
      user: {
        id: decoded.userId,
        email: decoded.email,
        role: decoded.role,
      },
      tenant: {
        slug: decoded.tenantSlug,
        role: decoded.tenantRole,
        name: decoded.tenantName,
        id: decoded.tenantId,
      },
      initialized: true,
    });
  }

  // Explicit logout transition
  function logout() {
    localStorage.removeItem("token");

    setAuth({
      user: null,
      tenant: null,
      initialized: true,
    });
  }

  return (
    <AuthContext.Provider
      value={{
        user: auth.user,
        tenant: auth.tenant,
        initialized: auth.initialized,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
