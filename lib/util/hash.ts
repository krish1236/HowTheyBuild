/**
 * One-way IP hashing for privacy. Never store raw IPs.
 *
 * Uses HMAC-SHA256 with a server-side secret (`IP_HASH_SECRET`). Two reasons
 * for HMAC over plain SHA-256:
 *   1. Without a secret, an attacker who steals the DB can recover IPs by
 *      pre-hashing the entire IPv4 space (~4B SHA-256 ops, hours on a GPU).
 *      With HMAC + secret, they need the secret too.
 *   2. Rotating the secret invalidates all prior hashes — useful if a DB
 *      dump leaks.
 */
import { createHmac } from "node:crypto";

let cachedSecret: string | null = null;

function getSecret(): string {
  if (cachedSecret) return cachedSecret;
  const s = process.env.IP_HASH_SECRET;
  if (!s || s === "change-me-to-a-long-random-string") {
    throw new Error(
      "IP_HASH_SECRET is not set (or is the default placeholder). Set it in .env to a long random string before serving traffic.",
    );
  }
  cachedSecret = s;
  return s;
}

export function hashIp(ip: string): string {
  return createHmac("sha256", getSecret()).update(ip).digest("hex");
}

/**
 * Pulls the client IP from request headers in priority order. Trusts the
 * proxy-set headers when running behind Cloudflare / Vercel / etc. In local
 * dev returns "local" so the hash is stable and identifiable.
 */
export function clientIpFromHeaders(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  return "local";
}
