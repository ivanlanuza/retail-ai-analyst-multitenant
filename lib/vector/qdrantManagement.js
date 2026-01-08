// lib/qdrantStore.js
//
// Qdrant + OpenAI embeddings helper wired for:
// - CommonJS (package.json: "type": "commonjs")
// - Usage from Next.js API routes (ES import syntax gets transpiled)
// - Usage from Node ESM scripts (e.g., scripts/index-knowledge.mjs via default import)
//
// We deliberately DO NOT use LangChain's QdrantVectorStore to avoid
// "Package subpath './vectorstores/qdrant' is not defined by 'exports'"
// errors. Instead, we talk directly to Qdrant via @qdrant/js-client-rest
// and provide a small facade with `addDocuments` and `similaritySearch`
// so the rest of the app can treat it like a normal vector store.

const { OpenAIEmbeddings } = require("@langchain/openai");
const { QdrantClient } = require("@qdrant/js-client-rest");

const { QDRANT_URL, QDRANT_API_KEY, OPENAI_API_KEY } = process.env;

function assertEnv() {
  const missing = [];
  if (!QDRANT_URL) missing.push("QDRANT_URL");
  if (!QDRANT_API_KEY) missing.push("QDRANT_API_KEY");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");

  if (missing.length) {
    throw new Error(
      `Missing Qdrant/OpenAI env vars: ${missing.join(
        ", "
      )}. Please set them in .env.local or .env`
    );
  }
}

let qdrantClientSingleton = null;
let embeddingsSingleton = null;

/**
 * Lazily create / reuse Qdrant client
 */
function getQdrantClient() {
  assertEnv();

  if (!qdrantClientSingleton) {
    qdrantClientSingleton = new QdrantClient({
      url: QDRANT_URL,
      apiKey: QDRANT_API_KEY,
      // Skip strict version compatibility check (client 1.13 vs server 1.16)
      // to avoid noisy warnings while still functioning correctly.
      checkCompatibility: false,
    });
  }

  return qdrantClientSingleton;
}

/**
 * Shared embeddings instance
 */
function getEmbeddings() {
  assertEnv();

  if (!embeddingsSingleton) {
    embeddingsSingleton = new OpenAIEmbeddings({
      apiKey: OPENAI_API_KEY,
      model: "text-embedding-3-small",
    });
  }

  return embeddingsSingleton;
}

/**
 * Ensure the Qdrant collection exists with the correct vector size.
 * If it doesn't exist, we create it based on the embedding dimension.
 */
async function ensureCollection(collection) {
  const client = getQdrantClient();
  const embeddings = getEmbeddings();

  // Try to get collection; if it fails, we create it
  try {
    await client.getCollection(collection);
    return { client, embeddings };
  } catch (err) {
    // Assume collection doesn't exist yet; create it
    const testVec = await embeddings.embedQuery("dimension probe");
    const vectorSize = Array.isArray(testVec) ? testVec.length : 1536;

    await client.createCollection(collection, {
      vectors: {
        size: vectorSize,
        distance: "Cosine",
      },
    });

    return { client, embeddings };
  }
}

/**
 * Low-level helper: add documents into Qdrant.
 * Each doc's `pageContent` and `metadata` are stored in the payload.
 */
async function addDocumentsInternal(client, embeddings, collection, documents) {
  if (!documents || documents.length === 0) return;

  const texts = documents.map((d) => d.pageContent || "");
  const vectors = await embeddings.embedDocuments(texts);

  const now = Date.now();
  const points = vectors.map((vec, idx) => ({
    // Use a string id to avoid JSON BigInt serialization issues
    id: now + idx,
    vector: vec,
    payload: {
      pageContent: texts[idx],
      metadata: documents[idx].metadata || {},
    },
  }));

  await client.upsert(collection, {
    wait: true,
    points,
  });
}

/**
 * Facade that mimics the subset of LangChain VectorStore API we actually use:
 * - similaritySearch(query, k)
 * - addDocuments(documents)
 */
function makeVectorStoreFacade(client, embeddings, collection) {
  return {
    /**
     * Add more documents to the existing collection (append).
     */
    async addDocuments(documents) {
      await addDocumentsInternal(client, embeddings, collection, documents);
    },

    /**
     * similaritySearch: embed query, search Qdrant, return "Document-like" objects.
     * Each result has:
     *   - pageContent
     *   - metadata
     *   - score  (similarity score from Qdrant)
     */
    async similaritySearch(query, k = 4) {
      const queryEmbedding = await embeddings.embedQuery(query);

      const result = await client.search(collection, {
        vector: queryEmbedding,
        limit: k,
      });

      // Map Qdrant points to Document-like objects used in /api/chat/ask.js
      return (result || []).map((point) => ({
        pageContent: point.payload?.pageContent || "",
        metadata: point.payload?.metadata || {},
        score: point.score,
      }));
    },
  };
}

function createQdrantHelper({ collection }) {
  if (!collection) {
    throw new Error("Qdrant collection is required for tenant-scoped helper");
  }

  async function getVectorStore() {
    const { client, embeddings } = await ensureCollection(collection);
    return makeVectorStoreFacade(client, embeddings, collection);
  }

  async function createVectorStoreFromDocuments(documents) {
    const client = getQdrantClient();
    const embeddings = getEmbeddings();

    try {
      await client.deleteCollection(collection);
    } catch (err) {
      // ignore if it doesn't exist
    }

    const testVec = await embeddings.embedQuery("dimension probe");
    const vectorSize = Array.isArray(testVec) ? testVec.length : 1536;

    await client.createCollection(collection, {
      vectors: {
        size: vectorSize,
        distance: "Cosine",
      },
    });

    await addDocumentsInternal(client, embeddings, collection, documents);

    return makeVectorStoreFacade(client, embeddings, collection);
  }

  return {
    getVectorStore,
    createVectorStoreFromDocuments,
  };
}

module.exports = {
  getEmbeddings,
  createQdrantHelper,
};
