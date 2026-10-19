# PostgreSQL Primary Database & Migration Guide

NovelForge uses **PostgreSQL** (`pg` driver) as its primary production database, configured via `DATABASE_URL`. In production (`NODE_ENV=production`), NovelForge requires a valid `postgres://` or `postgresql://` `DATABASE_URL` and **never silently falls back to SQLite**.

---

## 1. Architecture Overview

| Module | Responsibility |
|---|---|
| `src/lib/db/postgres.ts` | PostgreSQL `pg.Pool` connection pool management, connection string validation & credential redaction, SQL parameter translation (`?` and `@named` to `$1..$n`, `INSERT OR IGNORE` to `ON CONFLICT DO NOTHING`, `REAL` to `DOUBLE PRECISION`), `withPgTransaction` (`BEGIN` / `COMMIT` / `ROLLBACK`), `runPostgresMigrations`, and `checkPostgresHealth`. |
| `src/lib/db/postgres-sync-bridge.ts` | Worker-thread `SharedArrayBuffer` / `Atomics.wait` bridge providing the synchronous `getDb()` (`prepare().get/all/run`, `exec`, `transaction`) interface backed by a real PostgreSQL `pg.Pool`. |
| `src/lib/db/index.ts` | Primary database selector (`activeDatabaseDriver()`, `getDb()`, `migrateDatabase()`, `databaseStatus()`). Rejects missing or non-PostgreSQL `DATABASE_URL` in production. |
| `src/lib/db/migrations.ts` | Versioned, repeatable schema migrations `0001_initial_schema` through `0007_cloudinary_cover_metadata`. |
| `src/lib/db/sqlite-to-postgres.ts` & `scripts/migrate-sqlite-to-postgres.ts` | Non-destructive, idempotent, transactional SQLite-to-PostgreSQL data migration utility and CLI runner. |

---

## 2. Local & Production PostgreSQL Setup

### Local Development with Docker

```bash
docker run --name novelforge-pg \
  -e POSTGRES_USER=novelforge \
  -e POSTGRES_PASSWORD=novelforge_dev_pw \
  -e POSTGRES_DB=novelforge \
  -p 5432:5432 \
  -d postgres:16-alpine
```

Configure `.env.local`:

```env
DATABASE_URL="postgresql://novelforge:novelforge_dev_pw@localhost:5432/novelforge"
```

### Production Configuration

Set `DATABASE_URL` in your hosting environment (Neon, Supabase, AWS RDS, Railway, Render, Fly.io, etc.):

```env
DATABASE_URL="postgresql://user:password@db.example.com:5432/novelforge?sslmode=require"
PG_POOL_MAX="10"
PG_IDLE_TIMEOUT_MS="30000"
PG_CONNECTION_TIMEOUT_MS="10000"
```

---

## 3. Running Schema Migrations

Apply all pending versioned migrations (`0001`–`0007`):

```bash
npm run db:migrate
```

Inspect applied and pending migrations:

```bash
npm run db:status
```

---

## 4. Migrating Existing Data from SQLite to PostgreSQL

If you have existing local or staging data in a SQLite file (`./prisma/dev.db`), run the non-destructive migration CLI:

```bash
DATABASE_URL="postgresql://user:password@localhost:5432/novelforge" \
  npm run db:migrate:sqlite-to-pg -- --sqlite ./prisma/dev.db
```

### Safety Guarantees of `db:migrate:sqlite-to-pg`

1. **Non-Destructive Backup**: Automatically copies `./prisma/dev.db` to `./prisma/dev.db.pre-pg-migration.bak` before reading and **never deletes the original SQLite file**.
2. **Schema Preparation**: Ensures both source SQLite and target PostgreSQL have all migrations `0001`–`0007` applied.
3. **Foreign-Key Dependency Order**: Transfers all 30 tables in topological order (`users` -> `novels` -> `image_assets` -> `premises` -> `story_bibles` -> `characters` -> `chapter_outlines` -> `chapters` -> `chapter_versions`, etc.), deferring cyclic references (`novels.coverImageId` and `chapters.currentVersionId`) until child tables are populated.
4. **Idempotent Upserts**: Uses `ON CONFLICT (...) DO UPDATE` so re-running the migration updates existing records in place without creating duplicates.
5. **Transactional Rollback**: Wraps the entire transfer and post-transfer verification (row count parity and orphan checks) in a single PostgreSQL `BEGIN` / `COMMIT` / `ROLLBACK` transaction.
