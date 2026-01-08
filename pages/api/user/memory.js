// pages/api/user/memory.js
import { requireAuth } from "@/lib/auth/requireAuth";
import { coreQuery } from "@/lib/db/coreDb";

export default requireAuth(async function handler(req, res) {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (req.method === "GET") {
      // Fetch existing memory_summary for this user (if any)
      const rows = await coreQuery(
        `
        SELECT memory_summary
        FROM user_long_term_memory
        WHERE user_id = ?
        AND tenant_id = ?
        LIMIT 1
      `,
        [user.userId, user.tenantId]
      );

      const memorySummary =
        rows && rows.length > 0 && rows[0].memory_summary
          ? rows[0].memory_summary
          : "";

      return res.status(200).json({ memorySummary });
    }

    if (req.method === "POST" || req.method === "PUT") {
      const { memorySummary } = req.body || {};

      if (typeof memorySummary !== "string") {
        return res
          .status(400)
          .json({ error: "memorySummary must be a string." });
      }

      const trimmedSummary = memorySummary.trim();

      // Try to update an existing record first
      const result = await coreQuery(
        `
        UPDATE user_long_term_memory
        SET memory_summary = ?, updated_at = NOW()
        WHERE user_id = ?
      `,
        [trimmedSummary, user.userId]
      );

      // If no rows were updated, insert a new one
      if (!result || !result.affectedRows) {
        await coreQuery(
          `
          INSERT INTO user_long_term_memory (tenant_id, user_id, memory_summary)
          VALUES (?, ?, ?)
        `,
          [user.tenantId, user.userId, trimmedSummary]
        );
      }

      return res.status(200).json({ memorySummary: trimmedSummary });
    }

    // Method not allowed
    res.setHeader("Allow", ["GET", "POST", "PUT"]);
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("Error in /api/user/memory:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});
