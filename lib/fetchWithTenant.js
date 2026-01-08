import { getToken } from "@/lib/auth/clientAuth";
import { useAuth } from "@/lib/auth/AuthContext";

export function fetchWithTenant(url, options = {}, tenantSlug) {
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${getToken()}`,
      "X-Tenant-Slug": tenantSlug,
    },
  });
}
