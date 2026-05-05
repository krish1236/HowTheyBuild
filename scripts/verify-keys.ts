/**
 * Verifies that the API keys in `.env` actually authenticate, by calling
 * each provider's free list-models endpoint. Exits non-zero on any failure.
 * Use: `npx tsx --env-file=.env scripts/verify-keys.ts`
 */
import {
  isOpenAIConfigured,
  pingOpenAI,
} from "@/lib/clients/openai";
import {
  isAnthropicConfigured,
  pingAnthropic,
} from "@/lib/clients/anthropic";
import {
  isCohereConfigured,
  pingCohere,
} from "@/lib/clients/cohere";

type Result = "ok" | "skipped (not configured)" | `failed: ${string}`;

async function check(label: string, configured: boolean, ping: () => Promise<void>): Promise<Result> {
  if (!configured) return "skipped (not configured)";
  try {
    await ping();
    return "ok";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `failed: ${msg.slice(0, 200)}`;
  }
}

(async () => {
  const results = {
    openai: await check("openai", isOpenAIConfigured(), pingOpenAI),
    anthropic: await check("anthropic", isAnthropicConfigured(), pingAnthropic),
    cohere: await check("cohere", isCohereConfigured(), pingCohere),
  };

  console.log("provider verification:");
  for (const [name, result] of Object.entries(results)) {
    const mark = result === "ok" ? "✓" : result.startsWith("skipped") ? "·" : "✗";
    console.log(`  ${mark} ${name.padEnd(12)} ${result}`);
  }

  const failed = Object.values(results).filter((r) => r.startsWith("failed:"));
  process.exit(failed.length > 0 ? 1 : 0);
})();
