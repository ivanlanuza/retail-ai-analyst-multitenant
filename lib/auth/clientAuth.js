export function getToken() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

export function setToken(token) {
  localStorage.setItem("token", token);
}

export function clearToken() {
  localStorage.removeItem("token");
}

export function getUserFromToken() {
  const token = getToken();

  if (!token) return null;

  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payload = JSON.parse(atob(parts[1]));

    // Hard validation — REQUIRED
    if (!payload.userId || !payload.email || !payload.tenantSlug) {
      return null;
    }

    // Optional expiry check (recommended)
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      clearToken();
      return null;
    }

    console.log("Payload:", payload);
    // IMPORTANT: return a NEW object
    return { ...payload };
  } catch {
    return null;
  }
}
