import { ChatPromptTemplate } from "@langchain/core/prompts";
import { contentToString } from "./contentToString";

function emptyUsage() {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function safeJsonParse(text) {
  if (!text || typeof text !== "string") return null;

  const cleaned = text
    .trim()
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function normalizeXAxisValue(value) {
  if (value == null) return null;

  // mysql2 may return Date objects; stringify in a stable way
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const s = String(value).trim();
  if (!s) return null;
  return s;
}

function compareYearMonth(a, b) {
  // Works for common formats like YYYY-MM, YYYYMM, YYYY-MM-DD, ISO, etc.
  // We keep it simple: lexicographic compare is stable for year-first strings.
  return String(a || "").localeCompare(String(b || ""));
}

function detectYearMonthKey(columns) {
  if (!Array.isArray(columns) || columns.length === 0) return null;

  //console.log(columns);
  // Prefer the fully-qualified name if it is returned by the driver.
  if (columns.includes("metrics.yearmonth")) return "metrics.yearmonth";

  // Most MySQL drivers return the column name without the table prefix.
  if (columns.includes("yearmonth")) return "yearmonth";

  if (columns.includes("Month-Year")) return "Month-Year";
  if (columns.includes("Month")) return "Month";

  return null;
}

function getNumericCandidateKeys(columns, rows, excludeKey) {
  if (!Array.isArray(columns) || columns.length === 0) return [];
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const sample = clampArray(rows, 50);

  const candidates = [];

  for (const col of columns) {
    const key = String(col || "");
    if (!key) continue;
    if (excludeKey && key === excludeKey) continue;

    let nonNull = 0;
    let numeric = 0;

    for (const r of sample) {
      if (!isPlainObject(r)) continue;
      const v = r[key];
      if (v == null || v === "") continue;
      nonNull += 1;

      if (typeof v === "number" && Number.isFinite(v)) {
        numeric += 1;
        continue;
      }

      if (typeof v === "string") {
        const t = v.trim();
        if (!t) continue;
        const n = Number(t.replace(/,/g, ""));
        if (Number.isFinite(n)) numeric += 1;
      }
    }

    if (nonNull === 0) continue;

    const ratio = numeric / nonNull;
    if (ratio >= 0.6) candidates.push(key);
  }

  return candidates;
}

function clampArray(arr, max) {
  if (!Array.isArray(arr)) return [];
  if (arr.length <= max) return arr;
  return arr.slice(0, max);
}

async function inferMetricKeyWithAI({
  question,
  dateKey,
  numericCandidates,
  sampleRows,
  llm,
}) {
  if (!Array.isArray(numericCandidates) || numericCandidates.length === 0)
    return { metricKey: null, usage: emptyUsage() };

  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      [
        "You are helping pick the single best metric column to plot as an area chart over time.",
        "You will be given the following:",
        "- The user question",
        "- A date column (x-axis)",
        "- A list of numeric candidate columns (y-axis candidates)",
        "- A small sample of result rows",
        "Pick the ONE candidate that best answers the user question as a trend over time.",
        "Return STRICT JSON ONLY as JSON with exactly one key: metricKey (string).",
        "The metricKey value must be exactly one of the provided candidates.",
        "Do not include markdown fences.",
        "Do not include any other keys.",
      ].join(" "),
    ],
    [
      "human",
      [
        "User question:",
        "{question}",
        "",
        "Date key (x-axis): {dateKey}",
        "Numeric candidates (choose one): {candidatesJson}",
        "",
        "Sample rows (JSON):",
        "{rowsJson}",
        "",
        "Now respond with strict JSON only.",
      ].join("\n"),
    ],
  ]);

  const messages = await prompt.formatMessages({
    question: String(question || ""),
    dateKey: String(dateKey || ""),
    candidatesJson: JSON.stringify(numericCandidates),
    rowsJson: JSON.stringify(clampArray(sampleRows || [], 20)),
  });

  const resp = await llm.invoke(messages);
  const usage = resp.usage_metadata || emptyUsage();
  const obj = safeJsonParse(contentToString(resp.content));

  const metricKey =
    obj && typeof obj === "object" ? String(obj.metricKey || "").trim() : "";
  if (!metricKey) return { metricKey: null, usage };
  if (!numericCandidates.includes(metricKey)) return { metricKey: null, usage };
  return { metricKey, usage };
}

function pickMetricHeuristic(candidateKeys) {
  if (!Array.isArray(candidateKeys) || candidateKeys.length === 0) return null;
  if (candidateKeys.length === 1) return candidateKeys[0];

  const priorities = [
    /revenue|sales|amount|total|gross|net|profit/i,
    /count|transactions|orders|qty|quantity|units/i,
    /points|visits|members|customers/i,
  ];

  for (const re of priorities) {
    const hit = candidateKeys.find((k) => re.test(String(k)));
    if (hit) return hit;
  }

  // fallback: first candidate
  return candidateKeys[0];
}

async function buildBasicAreaChartPayload({ question, columns, rows, llm }) {
  const MAX_CHART_POINTS = 200;

  const dateKey = detectYearMonthKey(columns);
  if (!dateKey) return { chart: null, usage: emptyUsage() };

  const numericCandidates = getNumericCandidateKeys(columns, rows, dateKey);
  if (!numericCandidates || numericCandidates.length === 0) {
    return { chart: null, usage: emptyUsage() };
  }

  const sampleRows = clampArray(rows, 50);

  let metricKey = null;
  let usage = emptyUsage();
  try {
    const result = await inferMetricKeyWithAI({
      question,
      dateKey,
      numericCandidates,
      sampleRows,
      llm,
    });
    metricKey = result.metricKey;
    usage = result.usage || emptyUsage();
  } catch (err) {
    console.error(
      "Metric inference (AI) failed, falling back to heuristic:",
      err
    );
  }

  if (!metricKey) metricKey = pickMetricHeuristic(numericCandidates);
  if (!metricKey) return { chart: null, usage };

  // Build recharts-friendly data payload:
  // [{ [dateKey]: <date>, [metricKey]: <number> }, ...]
  const raw = clampArray(rows, MAX_CHART_POINTS)
    .map((r) => {
      if (!isPlainObject(r)) return null;

      const x = normalizeXAxisValue(r[dateKey]);
      if (!x) return null;

      const v = r[metricKey];
      if (v == null || v === "") return null;

      let y = v;
      if (typeof v === "string") {
        const n = Number(v.trim().replace(/,/g, ""));
        if (Number.isFinite(n)) y = n;
      }

      if (typeof y === "number" && !Number.isFinite(y)) return null;

      return { [dateKey]: x, [metricKey]: y };
    })
    .filter(Boolean);

  // Sort ascending by yearmonth lexicographically
  const sorted = raw.slice().sort((a, b) => {
    return compareYearMonth(a[dateKey], b[dateKey]);
  });

  if (sorted.length === 0) return { chart: null, usage };

  return {
    chart: {
      type: "basicareachart",
      xKey: dateKey,
      yKey: metricKey,
      data: sorted,
    },
    usage,
  };
}

export async function buildAreaChart({ question, fields, rows, llm }) {
  let chart = null;
  let usage = emptyUsage();
  try {
    const result = await buildBasicAreaChartPayload({
      question,
      columns: fields.map((f) => f.name),
      rows,
      llm,
    });
    if (result) {
      chart = result.chart || null;
      usage = result.usage || emptyUsage();
    }
  } catch (chartErr) {
    console.error("Chart payload build failed (non-fatal):", chartErr);
    chart = null;
  }

  return { chart, usage };
}
