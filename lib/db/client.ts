/**
 * Shared Postgres client.
 *
 * - Single pool per process (cached on globalThis to survive Next.js HMR in dev).
 * - Throws clearly if DATABASE_URL is not set, instead of failing on first query.
 * - Routes that import this MUST run on the Node.js runtime (not Edge);
 *   the `postgres` package uses `net`/`tls` which Edge does not provide.
 */
import postgres from "postgres";

const globalForSql = globalThis as unknown as {
  __htb_sql?: ReturnType<typeof postgres>;
};

function createClient() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  return postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

export const sql = globalForSql.__htb_sql ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForSql.__htb_sql = sql;
}
