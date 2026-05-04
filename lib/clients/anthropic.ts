/**
 * Anthropic client (used for query rewriting and answer generation).
 */
import Anthropic from "@anthropic-ai/sdk";

const globalForAnthropic = globalThis as unknown as {
  __htb_anthropic?: Anthropic;
};

export function getAnthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  if (globalForAnthropic.__htb_anthropic) return globalForAnthropic.__htb_anthropic;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  if (process.env.NODE_ENV !== "production") {
    globalForAnthropic.__htb_anthropic = client;
  }
  return client;
}

export function isAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Free list-models call; useful as a deep healthcheck. */
export async function pingAnthropic(): Promise<void> {
  await getAnthropic().models.list({ limit: 1 });
}
