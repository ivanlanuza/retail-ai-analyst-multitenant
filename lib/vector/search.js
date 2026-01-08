import { getQdrantClient } from "./qdrant";

export async function semanticSearchForTenant(tenant, vector, limit = 5) {
  const client = getQdrantClient();

  console.log(
    `Performing semantic search in collection ${tenant.qdrant_collection} with limit ${limit}`
  );

  return client.search(tenant.qdrant_collection, {
    vector,
    limit,
  });
}
