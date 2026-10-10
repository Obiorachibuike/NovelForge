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
- **Database** — portable SQL (SQLite for zero-setup dev, PostgreSQL documented for production) via a thin `better-sqlite3` layer. PostgreSQL support requires an adapter.

## Quick start (local development)

Requires **Node.js 22.x**.

```bash
npm ci
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
| `DATABASE_URL` | SQLite file URL, e.g. `file:./prisma/dev.db`. PostgreSQL requires a new database adapter; it is not currently implemented. |

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

The current runtime is designed for a **persistent, single-instance Node.js server**:
SQLite needs a writable persistent disk, local covers/exports are stored under
`public/uploads`, and the default queue runs in-process. PostgreSQL, cloud storage,
and Redis adapters are not yet implemented; setting their environment variables
alone does not enable them.

### Vercel build configuration

- Select **Next.js** as the framework, repository root as the root directory,
  **Node.js 22.x**, install command `npm ci`, and build command `npm run build`.
- The build is `next build` only. There is no Prisma schema/client in this app;
  SQLite tables are initialized by `src/lib/db/index.ts` on first database use.
- Redeploy the branch containing this fix, preferably without the old build cache.
- Set a strong `AUTH_SECRET` in each deployment environment.
- `vercel.json` pins the framework, install and build settings for every project linked
  to this repository; adding it turned the previously failing legacy project green, so keep
  it in place. See
  [`docs/vercel-deployment-failure-investigation.md`](docs/vercel-deployment-failure-investigation.md).
- This fixes compilation, not serverless persistence. Before using the studio on
  Vercel, implement a managed database adapter, persistent object storage, and a
  serverless-compatible job runner. Do not use `/tmp` SQLite as durable storage.
  Local file generation explicitly refuses to run on Vercel.

`npm run build` currently skips TypeScript and lint validation via the existing
Next.js configuration. Run `npm run typecheck` and `npm run lint` separately when
working on application correctness.

## The guiding principle

**The AI prepares the novel, the author controls the story, and NovelForge remembers everything that matters.**
