/**
 * Shared Redis client + thin cache helpers.
 *
 *   - One process-wide ioredis connection (cached on globalThis to survive
 *     Next.js HMR in dev). Lazy-creates on first use.
 *   - get<T>() / setJSON() / del() / withCache() over JSON-serialized values.
 *   - Cache is OPTIONAL: if REDIS_URL is unset, getRedis() returns null and
 *     the helpers degrade to "always miss, never store". This keeps the
 *     pipeline functional in environments without Redis.
 *
 * Key versioning: every helper takes a `prefix` (e.g. "embed:v1"). Bump the
 * version when the upstream output format changes — Module 8: "Version every
 * cache key" turns model migrations into painless invalidation.
 */
import Redis from "ioredis";

const globalForRedis = globalThis as unknown as {
  __htb_redis?: Redis | null;
};

export function getRedis(): Redis | null {
  if (globalForRedis.__htb_redis !== undefined) return globalForRedis.__htb_redis;
  const url = process.env.REDIS_URL;
  if (!url) {
    globalForRedis.__htb_redis = null;
    return null;
  }
  const client = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    // Buffer commands issued before the connection is ready; otherwise we
    // race with the TCP handshake on first use.
    enableOfflineQueue: true,
  });
  client.on("error", (err) => {
    // Don't crash the process on transient Redis errors; fall back to no-cache.
    console.warn("[redis]", err.message);
  });
  if (process.env.NODE_ENV !== "production") {
    globalForRedis.__htb_redis = client;
  }
  return client;
}

export function isCacheEnabled(): boolean {
  return getRedis() !== null;
}

export async function getJSON<T>(key: string): Promise<T | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn("[redis] getJSON failed:", (err as Error).message.slice(0, 120));
    return null;
  }
}

export async function setJSON(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (err) {
    console.warn("[redis] setJSON failed:", (err as Error).message.slice(0, 120));
  }
}

export async function del(key: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.del(key);
  } catch (err) {
    console.warn("[redis] del failed:", (err as Error).message.slice(0, 120));
  }
}

/**
 * Cache-or-compute helper. Returns the cached value if present, else runs
 * `compute`, stores the result, and returns it.
 *
 * Note: V1 does NOT do cross-process single-flight (would need Redis SETNX
 * + polling). Within one Node process, concurrent calls for the same key may
 * each compute once before the first one populates the cache. At V1 traffic
 * this is acceptable; Phase 9 adds proper request coalescing.
 */
export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<{ value: T; hit: boolean }> {
  const cached = await getJSON<T>(key);
  if (cached !== null) return { value: cached, hit: true };
  const value = await compute();
  await setJSON(key, value, ttlSeconds);
  return { value, hit: false };
}
