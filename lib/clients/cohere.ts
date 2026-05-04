/**
 * Cohere client (used for reranking via `rerank-v3.5`).
 */
import { CohereClient } from "cohere-ai";

const globalForCohere = globalThis as unknown as {
  __htb_cohere?: CohereClient;
};

export function getCohere(): CohereClient {
  if (!process.env.COHERE_API_KEY) {
    throw new Error("COHERE_API_KEY is not set");
  }
  if (globalForCohere.__htb_cohere) return globalForCohere.__htb_cohere;
  const client = new CohereClient({ token: process.env.COHERE_API_KEY });
  if (process.env.NODE_ENV !== "production") {
    globalForCohere.__htb_cohere = client;
  }
  return client;
}

export function isCohereConfigured(): boolean {
  return Boolean(process.env.COHERE_API_KEY);
}

/** Free list-models call; useful as a deep healthcheck. */
export async function pingCohere(): Promise<void> {
  await getCohere().models.list({ pageSize: 1 });
}
