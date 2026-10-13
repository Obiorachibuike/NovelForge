# PostgreSQL: current status and what is still required

**Status: not implemented.** This document exists so nobody has to guess. A
`postgres://` value in `DATABASE_URL` does **not** enable PostgreSQL — the app
rejects it with an actionable error rather than pretending.

## What the code does today

* `src/lib/db/index.ts` is the only database entry point. It opens a SQLite file
  with `better-sqlite3`, enables WAL, foreign keys and a 5 s busy timeout, then
  runs the versioned migrations from `src/lib/db/migrations.ts`.
* `resolveSqlitePath()` throws `DatabaseConfigurationError` for
  `postgres://` / `postgresql://` / `mysql://` URLs. Without that guard the URL
  would be treated as a filename and a stray file called `postgres://…` would be
  created in the working directory.
* Every query in the codebase (≈150 call sites across `src/services/**`,
  `src/lib/db/ownership.ts`, `src/lib/queue/**` and the server components) uses
  the synchronous better-sqlite3 API: `db.prepare(sql).get/all/run(...)` and
  `db.transaction(fn)`.
* `pg` **is** already a dependency (`package.json`) but nothing imports it.

## Why this matters for deployment

Vercel gives every deployment a read-only, ephemeral filesystem. A SQLite file
therefore:

* is lost on redeploy (and usually on cold start),
* is not shared between concurrent lambdas, so two requests can see different
  databases,
* cannot be written at all if it resolves inside the read-only bundle.

Covers and exports have a supported production answer today
(`STORAGE_PROVIDER=s3`, see `docs/storage.md`). The database does not, yet.

**Recommended deployment options until the adapter lands:**

1. **Persistent-disk host** (Fly.io volume, Railway/Render volume, a VPS):
   run NovelForge as a normal Node server (`npm run build && npm start`) with
   `DATABASE_URL=file:/data/novelforge.db` and `DATA_DIR=/data`. This is the
   supported production shape today.
2. **Wait for / contribute the PostgreSQL adapter** (below), then use any
   managed Postgres.

## What a PostgreSQL adapter requires

1. **Async data layer.** `pg` is asynchronous while better-sqlite3 is not, so
   every call site must become `await`. `db.transaction(fn)` has to become a
   scoped client with `BEGIN`/`COMMIT`/`ROLLBACK` (see
   `src/lib/queue/index.ts` for the transaction-heavy paths).
2. **Dialect changes.** `INSERT OR IGNORE` → `INSERT … ON CONFLICT DO NOTHING`,
   `AUTOINCREMENT` → `GENERATED … AS IDENTITY`, `?` placeholders → `$1…$n`,
   `strftime`/`datetime()` date math → `now()`/intervals, and boolean columns
   (currently `0`/`1` integers) → `boolean`.
3. **Schema.** Port `src/lib/db/migrations.ts` to a Postgres SQL file, keeping
   the `schema_migrations` table so a SQLite → Postgres data copy can be done
   row-by-row with a script.
4. **Queue semantics.** The atomic job claim in `src/lib/queue/index.ts` relies
   on `UPDATE … WHERE status='queued' … RETURNING`-style behaviour plus the
   partial unique index on `idempotencyKey`; check the Postgres equivalent
   (`SELECT … FOR UPDATE SKIP LOCKED` or `UPDATE … RETURNING`).
5. **Data migration plan** (small datasets, so a script is enough):
   1. `npm run db:status` on the SQLite deployment to confirm migrations;
   2. create the Postgres schema;
   3. copy `users → novels → novel_settings → premises → story_bibles →
      characters/… → chapter_outlines → chapters → chapter_versions →
      chapter_memories → generation_jobs → consistency_issues → ai_usage →
      image_assets → exports` in that order (foreign keys);
   4. keep the SQLite file and `DATA_DIR` as the rollback path; storage keys do
      not change, so covers/exports keep resolving.

## Verifying the current guard

```
DATABASE_URL=postgres://user:pass@host/db npx tsx --tsconfig tsconfig.worker.json scripts/db-migrate.ts
# → DatabaseConfigurationError: DATABASE_URL is a PostgreSQL URL but this build
#   only ships a SQLite driver. … see docs/postgresql.md
```

`tests/persistence/persistence.test.ts` covers the SQLite guarantees that exist
today: versioned migrations applied exactly once, and novels, settings,
chapters, covers, jobs and exports surviving a process restart.
