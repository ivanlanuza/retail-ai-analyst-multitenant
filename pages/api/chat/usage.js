// pages/api/chat/usage.js
import { requireAuth } from "@/lib/auth/requireAuth";
import { coreQuery } from "@/lib/db/coreDb";

export default requireAuth(async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const userId = user.userId;

    // Lifetime / month / week totals (by total_tokens)
    const [summary] = await coreQuery(
      `
      SELECT
        COALESCE(SUM(total_tokens), 0) AS lifetime_total,
        COALESCE(
          SUM(
            CASE
              WHEN created_at >= DATE_SUB(CURDATE(), INTERVAL (DAYOFMONTH(CURDATE()) - 1) DAY)
              THEN total_tokens
              ELSE 0
            END
          ),
          0
        ) AS month_total,
        COALESCE(
          SUM(
            CASE
              -- WEEKDAY(CURDATE()) = 0 => Monday
              WHEN created_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)
              THEN total_tokens
              ELSE 0
            END
          ),
          0
        ) AS week_total
      FROM token_usage
      WHERE user_id = ?
      AND tenant_id = ?
    `,
      [userId, user.tenantId]
    );

    // Daily totals for last 30 days
    const dailyRows = await coreQuery(
      `
      SELECT
        DATE(created_at) AS day,
        COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM token_usage
      WHERE user_id = ?
      AND tenant_id = ?
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at) ASC
    `,
      [userId, user.tenantId]
    );

    const daily = dailyRows.map((row) => {
      const dateObj = row.day instanceof Date ? row.day : new Date(row.day);
      return {
        date: dateObj.toISOString().slice(0, 10), // YYYY-MM-DD
        totalTokens: Number(row.total_tokens) || 0,
      };
    });

    return res.status(200).json({
      lifetimeTotalTokens: summary?.lifetime_total || 0,
      monthTotalTokens: summary?.month_total || 0,
      weekTotalTokens: summary?.week_total || 0,
      daily,
    });
  } catch (err) {
    console.error("Error in /api/chat/usage:", err);
    return res
      .status(500)
      .json({ error: "Failed to load usage stats", details: String(err) });
  }
});
