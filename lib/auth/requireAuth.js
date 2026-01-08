import { verifyToken } from "./jwt";

export function requireAuth(handler) {
  return async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      const token = auth.split(" ")[1];
      const decoded = verifyToken(token);

      // 🔒 Enforce required identity contract
      if (
        !decoded ||
        !decoded.userId ||
        !decoded.email ||
        !decoded.tenantSlug
      ) {
        return res.status(401).json({ error: "Invalid token" });
      }

      req.user = decoded;
      return handler(req, res);
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }
  };
}

export function requireSystemAdmin(handler) {
  return requireAuth((req, res) => {
    if (!req.user || req.user.role !== "SYSTEM_ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }
    return handler(req, res);
  });
}
