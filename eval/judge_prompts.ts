/**
 * LLM-as-judge for faithfulness scoring.
 *
 * Module 7 rule: use a STRONGER model than the generator. Generator is Sonnet,
 * so the default judge is Opus. The model is configurable via env so we can
 * swap to Sonnet for cheaper repeat runs once the rubric is calibrated.
 *
 * Output is forced into JSON via a structured prompt + post-parse.
 */
import { getAnthropic } from "@/lib/clients/anthropic";

export interface JudgeInput {
  query: string;
  retrieved_chunks: { chunk_id: string; text: string }[];
  answer: string;
  expected_summary: string;
}

export interface JudgeVerdict {
  /** Are ALL factual claims in the answer supported by retrieved chunks? */
  faithful: boolean;
  /** 0..1 score reflecting how thorough/correct the answer is vs. expected. */
  quality_score: number;
  /** Specific claims the judge identified as unsupported. */
  unsupported_claims: string[];
  /** Free-text reasoning the judge produced. Helpful for debugging. */
  rationale: string;
}

const SYSTEM_PROMPT = `You are a strict, fair evaluator of grounded Q&A answers from a Retrieval-Augmented Generation system. You have three jobs:

1. FAITHFULNESS — does every factual claim in the answer have direct support in the provided retrieved chunks? Mark as unfaithful if any claim is invented, exaggerated, or stated more confidently than the chunks warrant.
2. QUALITY — how completely and correctly does the answer address the question, given the retrieved chunks and the expected summary?
3. RATIONALE — explain your verdict briefly.

Be strict on faithfulness. If a chunk says "X is recommended" and the answer says "X is mandatory," that's an unfaithful claim. Names, numbers, and version identifiers must match the chunks exactly.

Output ONLY a single valid JSON object with this exact shape:
{
  "faithful": boolean,
  "quality_score": number,
  "unsupported_claims": [string, ...],
  "rationale": string
}

Where:
- faithful: true if every factual claim in the answer is supported by some retrieved chunk; false otherwise.
- quality_score: 0.0–1.0; 1.0 means complete and accurate per the expected summary, 0.0 means useless/wrong.
- unsupported_claims: a list of short paraphrases of claims you flagged as unfaithful. Empty list when faithful=true.
- rationale: 1–3 sentences explaining your judgment.

Do not output anything outside the JSON.`;

function buildUserMessage(input: JudgeInput): string {
  // Pass the FULL chunk text the generator saw. Slicing here was a bug —
  // the judge then flagged claims it had been denied evidence for.
  const chunks = input.retrieved_chunks
    .map((c) => `[chunk ${c.chunk_id}]\n${c.text}`)
    .join("\n\n---\n\n");

  return `QUESTION:
${input.query}

EXPECTED ANSWER SUMMARY (reference, not a strict template):
${input.expected_summary}

RETRIEVED CHUNKS (the only sources the generator was allowed to use):
${chunks}

GENERATED ANSWER:
${input.answer}

Judge the GENERATED ANSWER. Output the JSON verdict and nothing else.`;
}

/** Strip ```json fences if the model adds them despite instructions. */
function extractJson(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
  const m = fence.exec(trimmed);
  return m ? m[1] : trimmed;
}

export async function judgeAnswer(input: JudgeInput): Promise<JudgeVerdict> {
  const client = getAnthropic();
  const model =
    process.env.ANTHROPIC_JUDGE_MODEL || "claude-opus-4-5-20251101";

  const res = await client.messages.create({
    model,
    max_tokens: 600,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(input) }],
  });

  const block = res.content.find((b) => b.type === "text");
  const raw = block && "text" in block ? block.text : "";
  const json = extractJson(raw);

  try {
    const parsed = JSON.parse(json) as Partial<JudgeVerdict>;
    return {
      faithful: Boolean(parsed.faithful),
      quality_score:
        typeof parsed.quality_score === "number"
          ? Math.max(0, Math.min(1, parsed.quality_score))
          : 0,
      unsupported_claims: Array.isArray(parsed.unsupported_claims)
        ? parsed.unsupported_claims.map(String)
        : [],
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    };
  } catch {
    // Judge produced non-JSON; treat as a hard fail on faithfulness so
    // it surfaces in the report rather than silently passing.
    return {
      faithful: false,
      quality_score: 0,
      unsupported_claims: ["judge_parse_error"],
      rationale: `judge returned non-JSON: ${raw.slice(0, 200)}`,
    };
  }
}
