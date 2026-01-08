import { QdrantClient } from "@qdrant/js-client-rest";

let client;

export function getQdrantClient() {
  if (!client) {
    client = new QdrantClient({
      url: process.env.QDRANT_URL,
      apiKey: process.env.QDRANT_API_KEY,
    });
  }
  return client;
}
