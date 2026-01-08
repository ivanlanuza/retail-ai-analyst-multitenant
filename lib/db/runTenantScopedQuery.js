import { getDataDbConnectionForTenant } from "@/lib/db/dataDb";

// -----------------------------
// SQL safety guards
// -----------------------------

function normalize(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

function assertReadOnly(sql) {
  const s = normalize(sql).toUpperCase();

  if (!s.startsWith("SELECT ")) {
    const err = new Error("Only SELECT queries are allowed");
    err.code = "SQL_NOT_READ_ONLY";
    throw err;
  }

  /*
  // Prevent stacked queries
  if (s.includes("; ")) {
    const err = new Error("Multiple SQL statements are not allowed");
    err.code = "SQL_MULTIPLE_STATEMENTS";
    throw err;
  }*/

  // Prevent comment-based injection
  if (s.includes("--") || s.includes("/*") || s.includes("*/")) {
    const err = new Error("SQL comments are not allowed");
    err.code = "SQL_COMMENTS_NOT_ALLOWED";
    throw err;
  }

  // Prevent widening via UNION
  if (s.includes(" UNION ")) {
    const err = new Error("UNION queries are not allowed");
    err.code = "SQL_UNION_NOT_ALLOWED";
    throw err;
  }

  // Hard requirement: bounded result set
  if (!s.includes(" LIMIT ")) {
    const err = new Error("LIMIT clause is required");
    err.code = "SQL_LIMIT_REQUIRED";
    throw err;
  }
}

// -----------------------------
// Scope enforcement
// -----------------------------

function enforceScope(sql, scopeFilter) {
  if (!scopeFilter) return sql;

  // ALWAYS wrap to avoid operator-precedence exploits
  return `
    SELECT *
    FROM (
      ${sql}
    ) AS scoped_result
    WHERE (${scopeFilter})
  `;
}

// -----------------------------
// Public API
// -----------------------------

export async function runTenantScopedQuery(tenant, sql) {
  assertReadOnly(sql);

  const scopedSql = enforceScope(sql, tenant.scope_filter);

  const db = await getDataDbConnectionForTenant(tenant);
  const [rows, fields] = await db.query(scopedSql);

  return {
    rows,
    fields,
    sql: scopedSql,
  };
}
