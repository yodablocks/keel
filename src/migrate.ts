import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations/", import.meta.url));

// Arbitrary constant so concurrent migrate() calls (parallel test files, several deploys) serialize.
const MIGRATION_LOCK_ID = 7_413_001;

/** Applies every db/migrations/*.sql file not yet applied, in filename order, each in its own transaction. */
export async function migrate(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS keel_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const { rows } = await client.query<{ name: string }>("SELECT name FROM keel_migrations");
    const applied = new Set(rows.map((r) => r.name));
    const pending = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql") && !applied.has(f)).sort();

    for (const file of pending) {
      const sql = await readFile(MIGRATIONS_DIR + file, "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO keel_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return pending;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    await client.end();
  }
}
