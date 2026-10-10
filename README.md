# NovelForge

> The AI prepares the novel, the author controls the story, and NovelForge remembers everything that matters.

NovelForge is a production-quality AI-powered novel-writing and digital publishing studio. It takes a novel from **Title → Cover → Preparation → Story Bible → Outline → Sequential Writing → Synchronization → Consistency → Export**, generating **one chapter at a time** under the author's explicit approval.

## Features

- **Next.js 14 App Router** with React Server Components, TypeScript, Tailwind CSS, Framer Motion, Lucide, TanStack Query.
- **Auth.js v5** with credentials + optional Google OAuth.
- **Tiptap** rich-text editor with autosave, version history, word counts, selection-based AI editing.
- **Structured AI layer** (OpenAI) with provider interface, streaming, structured JSON output (Zod-validated), embeddings, cost tracking. Works in **demo mode** with deterministic placeholder content when no API key is set.
- **Sequential writing engine** — only one chapter unlocked at a time; explicit approval unlocks the next. Failure recovery via persisted job records.
- **Story Bible** — characters, locations, world rules, timeline events, plot threads; updated automatically after chapter approval.
- **Story memory** with embeddings (OpenAI or a deterministic stub in demo mode) for retrieval-augmented chapter generation.
- **Consistency engine** — heuristic + AI checks for timeline clashes, dead characters appearing, word-count targets, world-rule violations.
- **Exports** to DOCX, PDF, TXT, Markdown (EPUB stub extensible).
- **Queue abstraction** — in-process runner for development; Redis/BullMQ adapter documented for production.
- **Storage abstraction** — local disk for development; Cloudinary adapter documented for production.
- **Database** — portable SQL (SQLite for zero-setup dev, PostgreSQL documented for production) via a thin `better-sqlite3` layer with a Prisma-compatible schema.

## Quick start (local development)

```bash
npm install
cp .env.example .env          # uses SQLite + demo AI mode by default
npm run dev
```

Open http://localhost:3000. Register with any email/password — no external services required. In demo mode, stylized SVG covers and deterministic chapter text are used.

### Optional services

Configure the following in `.env` to enable production-grade providers:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Enables real AI text, structured output, embeddings, and (if model supports) image generation |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google OAuth |
| `REDIS_URL` | Switches queue from in-process to BullMQ-backed (worker runs via `npm run worker`) |
| `CLOUDINARY_*` | Cloudinary image storage |
| `DATABASE_URL` | Set to a PostgreSQL URL for production; schema in `src/lib/db/index.ts` mirrors the Prisma schema documented in the spec |

Run a dedicated worker (for Redis / BullMQ mode):

```bash
npm run worker
```

## Project structure

```
src/
  app/                     Next.js App Router pages and route handlers
    (studio)/              Protected app layout (dashboard + novel workspaces)
    api/                   Route Handlers for novels, chapters, AI actions, export
  components/
    ui/                    shadcn-style primitives
    editor/                Tiptap editor workspace
    story-bible/           Preparation + Bible views
    outline/               Outline editor
    visuals/               Cover studio
    consistency/           Consistency checker
    export/                Export UI
    layout/                Sidebar / headers
  lib/
    ai/                    Provider-agnostic AI layer (text/structured/embeddings/usage/prompts)
    auth/                  Auth.js config
    db/                    SQLite (and PG-compatible SQL) data layer + ownership helpers
    queue/                 In-process job runner (Redis adapter documented)
    storage/               Local disk / Cloudinary abstraction
    utils/                 cn, formatters, words-to-pages, hash
  services/
    novels/                Core novel/settings/progress service
    images/                Cover generation (OpenAI images with SVG demo fallback)
    preparation/           Premise + Story Bible initial generation
    outlines/              Story structure + chapter outline generation
    chapters/              Sequential writing, autosave, versions, approval, summary memory
    memory/                Embedding-based story memory retrieval
    consistency/           AI + heuristic continuity checks
    exports/               DOCX / PDF / TXT / Markdown / EPUB
  worker/                  Standalone worker entrypoint
```

## Workflow implementation status

- [x] Registration & login (credentials, Google OAuth optional)
- [x] Novel creation wizard (title, genre, targets, mode)
- [x] Cover generation (OpenAI images when configured; SVG fallbacks in demo)
- [x] Primary cover selection → advances stage
- [x] Novel preparation (premise, synopsis, themes, setting, characters, world rules, timeline)
- [x] Story Bible tabs (overview, characters, locations, world rules, timeline, plot threads)
- [x] Story structure + complete chapter outline generation with word budgets
- [x] Outline approval gate
- [x] **Sequential chapter generation** — next chapter locked until previous approved
- [x] Tiptap editor with toolbar, autosave, word counts, placeholder, formatting
- [x] Versioning on snapshot
- [x] Chapter summary, character/thread/timeline/world-rule extraction on approval
- [x] Story memory retrieval with cosine/keyword hybrid search
- [x] Selection-based AI editor actions (continue, rewrite, expand, shorten, improve, dialogue)
- [x] Consistency engine with heuristics + AI analysis
- [x] Export to DOCX, PDF, TXT, Markdown (EPUB adapter prepared)
- [x] Responsive premium dark-themed UI, accessible controls
- [x] Job persistence, retries, idempotency keys
- [x] Ownership checks on every protected route

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Next.js dev server (port 3000, binds 0.0.0.0) |
| `npm run build` | Production build |
| `npm run start` | Serve production build |
| `npm run worker` | Run the background worker (in-process or BullMQ when REDIS_URL is set) |
| `npm run lint` / `typecheck` | Lint & type check |
| `npm test` | Run Vitest unit tests |

## Production deployment notes

- Use a **managed PostgreSQL** service (Neon, Supabase, RDS, …) and swap `DATABASE_URL` to a Postgres connection string. The SQL schema in `src/lib/db/index.ts` uses portable types.
- Use **Redis** (Upstash, Railway, ElastiCache) and set `QUEUE_PROVIDER=redis` + `REDIS_URL` to enable BullMQ workers. Run `npm run worker` as a separate process.
- Configure **Cloudinary** (or S3) via `STORAGE_PROVIDER=cloudinary` for persistent image/export storage.
- **Vercel** is recommended for the Next.js app; deploy the worker as a separate service (Fly.io, Railway, Render, etc).

## The guiding principle

**The AI prepares the novel, the author controls the story, and NovelForge remembers everything that matters.**
