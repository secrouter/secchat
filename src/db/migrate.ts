// Applies db/migrations/*.sql, in filename order, exactly once each.
//
// Bookkeeping lives in `schema_migrations` (filename primary key). Each migration file is
// itself one self-contained `BEGIN; … COMMIT;` block (see db/migrations/0001_init.sql and
// 0002_parity.sql), sent to Postgres as a single multi-statement query — the simple query
// protocol runs that whole string as one atomic unit, governed by the file's OWN transaction
// boundaries. We deliberately do NOT wrap that call in a second, outer client-side transaction:
// nesting a nested BEGIN…COMMIT inside an already-open one doesn't compose the way you'd want
// (the inner COMMIT would end the outer transaction early), and it isn't necessary — if any
// statement in the file fails, Postgres aborts that file's transaction, the file's own COMMIT
// becomes a no-op rollback, `pool.query(sql)` rejects, and we never reach the bookkeeping INSERT
// below — so a failed migration is correctly left unrecorded and will be retried on the next
// `migrate()` call. Applying the file and recording it are therefore two sequential statements
// rather than one enclosing transaction; the only residual gap is a crash in the (very short)
// window between them, which would require a manual `schema_migrations` fix-up on restart — a
// standard, accepted trade-off for migration tooling built around self-transactional SQL files.
//
// Idempotent: safe to call on every process start. test/pg.test.ts also calls this directly
// after resetting the schema, so it's exercised as the app's real boot-time migration path.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

// db/migrations lives at the repo root; this module is at src/db/migrate.ts, so it's two
// directories up from here.
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "migrations");

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL
    )
  `);

  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((f) => f.endsWith(".sql")).sort();

  for (const filename of files) {
    const { rows } = await pool.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations WHERE filename = $1",
      [filename],
    );
    if (rows.length > 0) continue; // already applied

    const sql = await readFile(join(MIGRATIONS_DIR, filename), "utf8");
    await pool.query(sql); // the file's own BEGIN…COMMIT governs atomicity (see header comment)
    await pool.query("INSERT INTO schema_migrations (filename, applied_at) VALUES ($1, $2)", [
      filename,
      new Date().toISOString(),
    ]);
  }
}
