#!/usr/bin/env node

// scripts/index-knowledge.mjs
//
// Usage:
//   node scripts/index-knowledge.mjs
//   node scripts/index-knowledge.mjs --append                     # add to existing collection
//   node scripts/index-knowledge.mjs --tables users,orders        # only index these tables
//   node scripts/index-knowledge.mjs --table users --table orders # same as above
//
// This file is an ES module (.mjs) that talks to a CommonJS helper
// in lib/qdrantStore.js. package.json is configured with:
//   "type": "commonjs"
// so all .js files are CommonJS, and .mjs files are ESM.

import "dotenv/config";
import fs from "fs";
import path from "path";
import mysql from "mysql2/promise";
import { fileURLToPath } from "url";
import { Document } from "@langchain/core/documents";
import qdrantStoreModule from "../lib/qdrantStore.js";

// When importing a CommonJS module from ESM, Node gives you module.exports
// directly as the default export. There is no .default field.
const qdrantStore = qdrantStoreModule.default || qdrantStoreModule;
const { createVectorStoreFromDocuments, getVectorStore } = qdrantStore;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, QDRANT_COLLECTION } =
  process.env;

function parseCliArgs(argv) {
  const args = argv.slice(2);

  const out = {
    append: false,
    tables: [], // optional allowlist; empty => all tables
  };

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];

    if (a === "--append") {
      out.append = true;
      continue;
    }

    // --tables users,orders OR --tables users orders (but we recommend comma-separated)
    if (a === "--tables" || a.startsWith("--tables=")) {
      const raw = a.startsWith("--tables=")
        ? a.split("=").slice(1).join("=")
        : args[i + 1];
      if (!a.startsWith("--tables=")) i += 1;

      if (raw) {
        const parts = String(raw)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        out.tables.push(...parts);
      }
      continue;
    }

    // Repeatable: --table users --table orders
    if (a === "--table") {
      const raw = args[i + 1];
      i += 1;
      if (raw) out.tables.push(String(raw).trim());
      continue;
    }

    // Ignore unknown flags but keep it visible
    if (a.startsWith("--")) {
      console.warn(`Unknown flag ignored: ${a}`);
    }
  }

  // de-dupe while keeping order
  const seen = new Set();
  out.tables = out.tables.filter((t) => {
    if (!t) return false;
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });

  return out;
}

function assertDbEnv() {
  const missing = [];
  if (!DB_HOST) missing.push("DB_HOST");
  if (!DB_USER) missing.push("DB_USER");
  if (!DB_NAME) missing.push("DB_NAME");
  if (!QDRANT_COLLECTION) missing.push("QDRANT_COLLECTION");

  if (missing.length > 0) {
    throw new Error(
      `Missing DB/Qdrant env vars: ${missing.join(
        ", "
      )}. Check your .env.local or .env file.`
    );
  }
}

/**
 * Fetch schema from MySQL and convert to LangChain Documents.
 * One document per table.
 */
async function fetchSchemaDocs({ includeTables = [] } = {}) {
  assertDbEnv();

  const connection = await mysql.createConnection({
    host: DB_HOST,
    user: DB_USER,
    database: DB_NAME,
    password: DB_PASSWORD,
  });

  try {
    const baseSql =
      `SELECT TABLE_NAME, TABLE_COMMENT\n` +
      `FROM information_schema.tables\n` +
      `WHERE table_schema = ?`;

    const params = [DB_NAME];

    let sql = baseSql;

    if (Array.isArray(includeTables) && includeTables.length > 0) {
      const placeholders = includeTables.map(() => "?").join(",");
      sql += ` AND TABLE_NAME IN (${placeholders})`;
      params.push(...includeTables);
    }

    sql += " ORDER BY TABLE_NAME";

    const [tables] = await connection.execute(sql, params);

    const docs = [];

    for (const table of tables) {
      const tableName = table.TABLE_NAME;

      const [columns] = await connection.execute(
        `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, COLUMN_KEY, IS_NULLABLE,
                COLUMN_DEFAULT, COLUMN_COMMENT
         FROM information_schema.columns
         WHERE table_schema = ? AND table_name = ?
         ORDER BY ORDINAL_POSITION`,
        [DB_NAME, tableName]
      );

      const tableText = [
        `Table: ${tableName}`,
        `Schema: ${DB_NAME}`,
        `Description: ${table.TABLE_COMMENT || "n/a"}`,
        "",
        "Columns:",
        ...columns.map((c) => {
          const pieces = [];
          pieces.push(`- ${c.COLUMN_NAME}`);
          pieces.push(`type=${c.DATA_TYPE} (${c.COLUMN_TYPE})`);
          if (c.COLUMN_KEY) pieces.push(`key=${c.COLUMN_KEY}`);
          pieces.push(`nullable=${c.IS_NULLABLE}`);
          if (c.COLUMN_DEFAULT !== null) {
            pieces.push(`default=${c.COLUMN_DEFAULT}`);
          }
          if (c.COLUMN_COMMENT) {
            pieces.push(`comment=${c.COLUMN_COMMENT}`);
          }
          return pieces.join(" | ");
        }),
      ].join("\n");

      const doc = new Document({
        pageContent: tableText,
        metadata: {
          type: "schema",
          source: "mysql_schema",
          schema: DB_NAME,
          table_name: tableName,
          title: `Schema for ${tableName}`,
        },
      });

      docs.push(doc);
    }

    const filterNote =
      Array.isArray(includeTables) && includeTables.length > 0
        ? ` (filtered: ${includeTables.join(", ")})`
        : "";
    console.log(
      `Fetched schema for ${docs.length} tables from ${DB_NAME}${filterNote}`
    );
    return docs;
  } finally {
    await connection.end();
  }
}

/**
 * Load local reference docs from /docs (markdown & text files).
 * You can drop:
 *   - data_dictionary.md
 *   - kpi_definitions.md
 *   - faq.txt
 * etc. into that folder.
 */
function loadLocalDocs() {
  const docsDir = path.join(__dirname, "..", "docs");

  if (!fs.existsSync(docsDir)) {
    console.warn(
      `No docs directory found at ${docsDir}. Skipping local business docs.`
    );
    return [];
  }

  const entries = fs.readdirSync(docsDir);
  const docs = [];

  for (const file of entries) {
    const fullPath = path.join(docsDir, file);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;

    const ext = path.extname(file).toLowerCase();
    if (![".md", ".txt"].includes(ext)) {
      // you can extend this to ".pdf" with a PDF parser later
      continue;
    }

    const content = fs.readFileSync(fullPath, "utf8");
    const title = path.basename(file, ext);

    const doc = new Document({
      pageContent: content,
      metadata: {
        type: "business_doc",
        source: "local_file",
        title,
        filename: file,
      },
    });

    docs.push(doc);
  }

  console.log(`Loaded ${docs.length} local docs from /docs`);
  return docs;
}

/**
 * Chunk documents into overlapping windows for better retrieval.
 * Simple manual splitter to avoid extra dependencies.
 */
function chunkDocuments(documents) {
  if (!documents.length) return [];

  const chunkSize = 1000;
  const chunkOverlap = 200;
  const effectiveStep = chunkSize - chunkOverlap;

  const splitDocs = [];

  for (const doc of documents) {
    const text = doc.pageContent || "";
    const meta = doc.metadata || {};
    if (!text.length) continue;

    let start = 0;
    let chunkIndex = 0;

    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      const chunkText = text.slice(start, end);

      splitDocs.push(
        new Document({
          pageContent: chunkText,
          metadata: {
            ...meta,
            chunk_index: chunkIndex,
          },
        })
      );

      chunkIndex += 1;
      start += effectiveStep;
    }
  }

  console.log(
    `Chunked ${documents.length} docs into ${splitDocs.length} chunks`
  );

  return splitDocs;
}

/**
 * Main indexing routine.
 */
async function main() {
  const { append, tables } = parseCliArgs(process.argv);

  console.log("=== Retail AI Analyst: Index Knowledge ===");
  console.log(
    `Mode: ${
      append ? "append to existing collection" : "rebuild/create collection"
    }`
  );
  console.log(`Collection: ${QDRANT_COLLECTION}`);
  console.log("");

  if (tables.length > 0) {
    console.log(`Tables: ${tables.join(", ")}`);
    console.log("");
  }

  // 1) Prepare documents
  const schemaDocs = await fetchSchemaDocs({ includeTables: tables });
  const businessDocs = loadLocalDocs();

  const allDocs = [...schemaDocs, ...businessDocs];

  if (allDocs.length === 0) {
    console.warn("No documents to index. Exiting.");
    return;
  }

  const splitDocs = chunkDocuments(allDocs);

  // 2) Index into Qdrant
  if (append) {
    console.log("Appending documents to existing Qdrant collection...");
    const store = await getVectorStore();
    await store.addDocuments(splitDocs);
    console.log("Append complete.");
  } else {
    console.log("Creating/replacing Qdrant collection from documents...");
    await createVectorStoreFromDocuments(splitDocs);
    console.log("Initial indexing complete.");
  }

  console.log("=== Indexing finished successfully ===");
}

main().catch((err) => {
  console.error("Error in scripts/index-knowledge.mjs:", err);
  process.exit(1);
});
