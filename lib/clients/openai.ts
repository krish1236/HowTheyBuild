/**
 * OpenAI client (used for embeddings via `text-embedding-3-small`).
 */
import OpenAI from "openai";

const globalForOpenAI = globalThis as unknown as { __htb_openai?: OpenAI };

export function getOpenAI(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  if (globalForOpenAI.__htb_openai) return globalForOpenAI.__htb_openai;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  if (process.env.NODE_ENV !== "production") {
    globalForOpenAI.__htb_openai = client;
  }
  return client;
}

export function isOpenAIConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/** Free list-models call; useful as a deep healthcheck. */
export async function pingOpenAI(): Promise<void> {
  await getOpenAI().models.list();
}
