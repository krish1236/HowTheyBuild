/**
 * Migration runner. Reads SQL files from lib/db/migrations/ in lexicographic
 * order, applies any not yet recorded in _migrations, each in a transaction.
 *
 * Usage: pnpm db:migrate
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";

const MIGRATIONS_DIR = join(process.cwd(), "lib", "db", "migrations");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const sql = postgres(url, { max: 1 });

  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = new Set(
    (await sql<{ filename: string }[]>`SELECT filename FROM _migrations`).map(
      (r) => r.filename,
    ),
  );

  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`✓ ${file} (already applied)`);
      continue;
    }
    const body = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    console.log(`→ applying ${file}...`);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO _migrations (filename) VALUES (${file})`;
    });
    console.log(`✓ ${file}`);
    appliedCount++;
  }

  console.log(
    appliedCount === 0
      ? "No new migrations to apply."
      : `Applied ${appliedCount} migration(s).`,
  );

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
