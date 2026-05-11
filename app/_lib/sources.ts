/**
 * Map a human-readable source name to a short code used on citation chips.
 * Keep these stable — they're the visible token next to the citation number
 * in the answer body (e.g. `cf · 03`).
 */

const SHORT_CODES: Record<string, string> = {
  "Cloudflare Blog": "cf",
  "AWS Blog": "aws",
  "AWS Architecture Blog": "awsa",
  "Airbnb Engineering": "abnb",
  "GitHub Engineering": "gh",
  "Slack Engineering": "slk",
  "Pinterest Engineering": "pin",
  "Dropbox Tech": "dbx",
  "Meta Engineering": "meta",
};

export function sourceShortCode(sourceName: string): string {
  if (SHORT_CODES[sourceName]) return SHORT_CODES[sourceName];
  // Fallback: first 4 lowercase letters of the source name.
  return sourceName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 4);
}
