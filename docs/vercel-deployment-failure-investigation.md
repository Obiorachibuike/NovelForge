# Vercel deployment failure — investigation

**Date:** 2026-10-10 · **Scope:** the deployment check that failed after PR #3 (`e0130fe`) was merged into `main`.

## TL;DR

Two separate Vercel projects are connected to this repository:

| Project | Status on the merged fix (`e0130fe`) |
| --- | --- |
| `novel-forge` (legacy — created during the initial Vite prototype) | ❌ **failure** |
| `novel-forge-hvkj` (created 2026-10-10) | ✅ **success** (preview and production) |

The commit is not the problem. `e0130fe` builds cleanly in the parallel project and in a clean local
build. The failing deployment belongs to the **legacy `novel-forge` project**, whose build configuration
still dates from the era when this repository was a Vite single-page app. That project last succeeded on
the Vite commit `ef3a5fd` (2026-10-04) and has failed on **100 % of the Next.js commits**, both before and
after the fix.

The legacy project's build never reached `next build`: it still resolved a Vite-era framework preset /
build command, which no code change in PR #3 could affect — only its *build configuration* could.

**Resolved.** Adding [`vercel.json`](../vercel.json) (framework `nextjs`, install `npm ci`, build
`npm run build`) in the same PR fixed it: the legacy project has been green on every commit since, and all
three linked projects deploy successfully from `main`. See [Resolution](#resolution-2026-10-10) below.

## Evidence

### 1. Same project, Vite success vs. Next.js failures

The commit statuses expose the owning project in their target URLs
(`vercel.com/obiorachibuikes-projects/<project>/<deployment>`):

| Commit | Repo state | `novel-forge` (legacy) | `novel-forge-hvkj` |
| --- | --- | --- | --- |
| `ef3a5fd` — *Build NovelForge writing studio experience (#1)* (2026-10-04 22:42Z) | **Vite** SPA (`vite.config.js`, `index.html`, `"build": "vite build"`) | ✅ **success** (dpl `3ZKn7Ux61vhPaRoHxHqEt4oXL1AN`) | not linked yet |
| `2bbdd6f` — *NovelForge Next.js studio* (2026-10-10 11:58Z) | Next.js rewrite (PR #2) | ❌ failure (dpl `A7tGy3Cw4Q9zY8o59xP2KK835kmF`) | not linked yet |
| `340e5b6` — merge PR #2 (2026-10-10 12:02Z / 15:22Z) | Next.js + dead Prisma build script | ❌ failure (dpl `DZqTPkn8P6QQVQLgkKzc9QcNfzhz`) | ❌ failure (dpl `6TtmLZ7HTotMwPeyTJ7bupAGPXdT`, expected — pre-fix code) |
| `5beaab1` — PR #3 branch, the fix (2026-10-10 21:56Z / 21:57Z) | Next.js fixed | ❌ failure (dpl `owrvBcJnKrRvf5cgKJ8qSDoyufRv`) | ✅ **success** (dpl `BnkpGP1ZwUtkjKP5jXg8eg1VwKGp`) |
| `e0130fe` — merged fix (2026-10-10 21:58Z / 21:59Z) | Next.js fixed | ❌ failure (dpl `6bAsT7dDQJNwcX8uCKRyZBBfE96g`) | ✅ **success**, production (dpl `GmzE2CXVAjy8ZvWFeH27qjiTViXU`) |

The only green build the legacy project ever produced was the Vite commit. Everything it has built since
the Next.js rewrite has failed, regardless of code changes.

### 2. The merged commit is verified-good

* **Parity project:** `novel-forge-hvkj` produced a successful preview and a successful **production**
  deployment from `e0130fe`.
* **Clean local build:** from a fresh checkout of `e0130fe`, `npm ci --ignore-scripts` followed by
  `npx next build` **succeeded in 48 s** — 13 API routes compiled, 11/11 static pages generated,
  middleware bundle emitted at 76.2 kB. It was run with **no environment variables set at all**
  (no `DATABASE_URL`, no `AUTH_SECRET`, no `AI_DEMO_MODE`).

Because the local install deliberately skipped native-module compilation (`--ignore-scripts`, this sandbox
cannot reach `nodejs.org` for node-gyp headers), that successful build also proves the build performs **no
database access at build time** — nothing loads `better-sqlite3` while compiling or prerendering. Vercel
project environment variables therefore cannot be the cause of the failure.

### 3. Failure signatures to look for in the legacy project's build logs

Logs are only reachable from an account with access to the Vercel dashboard (vercel.com is not reachable
from this workspace), so this is the one confirmation step that has to be run on the user's side:

```bash
npx vercel inspect dpl_6bAsT7dDQJNwcX8uCKRyZBBfE96g --logs   # legacy project, merged fix
npx vercel inspect dpl_owrvBcJnKrRvf5cgKJ8qSDoyufRv --logs   # legacy project, PR branch
```

Expected signatures, mapping to the two plausible stale settings:

| Log shows | Meaning |
| --- | --- |
| `vite build` … `Could not resolve entry module "index.html"` | Project framework preset is still **Vite** (build command `vite build` + output `dist`) |
| `prisma: not found` / `sh: 1: prisma: command not found` / `Could not find a schema.prisma file` | Build command is a **hand-pinned Prisma command** typed into the dashboard during the Prisma era |

The first signature was reproduced locally against the current repository, with `vite` resolving
transitively via `vitest`:

```
vite v5.4.21 building for production...
✓ 0 modules transformed.
x Build failed in 15ms
error during build:
Could not resolve entry module "index.html".
```

### 4. What is *not* the cause

* **Application code** — builds successfully in two independent environments (`novel-forge-hvkj` and a
  clean local build of the same commit).
* **Vercel environment variables** — the build touches no database (see §2).
* **The Node.js 22.x pin** — `better-sqlite3@13` declares `engines.node >= 22`, and npm treats an engines
  mismatch as a warning (`EBADENGINE`, exit code 0 — verified), not a build failure.
* **The Prisma removal in PR #3** — that fix was real and necessary: at `340e5b6`, `scripts.build` was
  `prisma generate && prisma migrate deploy && next build`, while the repository contained neither the
  `prisma` CLI package nor any `schema.prisma`, so the pre-fix command could only fail with
  `prisma: not found`. Removing it fixed the *code-side* failure; the legacy project additionally needed
  its Vite-era build configuration corrected (see [Resolution](#resolution-2026-10-10)).

## Root cause

The legacy `novel-forge` Vercel project still carries **build settings from the Vite prototype era**
(framework preset `Vite` → `vite build` + output directory `dist`, and/or a hand-pinned Prisma build
command). Its assumptions stopped being true when PR #2 replaced the Vite SPA with the Next.js app, so it
kept failing while every other project built the same commits — until repository-level configuration was
supplied in `vercel.json` (see [Resolution](#resolution-2026-10-10)).

## Resolution (2026-10-10)

The commit that added `vercel.json` was also the first commit the legacy project built successfully since
the Vite era — it never needed a dashboard click:

| Commit | `novel-forge` (legacy) | `novel-forge-hvkj` | `novel-forge-v9b1` |
| --- | --- | --- | --- |
| `e0130fe` — merged fix, no `vercel.json` (21:58Z) | ❌ failure | ✅ success | ✅ success (22:25Z) |
| `c1bf43f` — adds `vercel.json`, unmerged (22:05Z) | ✅ **success** | ✅ success | — |
| `b4e2df0` — `vercel.json` merged into `main` (22:33Z) | ✅ success (22:36Z) | ✅ success (22:35Z) | ✅ success (22:34Z) |

**Correction to an assumption in the first version of this document:** it claimed dashboard settings would
always win over repository configuration, so only a dashboard change could help. In practice, adding
`vercel.json` changed the legacy project's build resolution immediately (its `e0130fe` deploy failed at
21:58Z; its `c1bf43f` deploy was green at 22:05Z, before any merge or other activity). Whatever stale
Vite-era value it held was overridable from the repository, which is the better outcome: the correct build
configuration is now versioned with the code, and fresh imports inherit it.

### Remaining housekeeping (optional, dashboard-side)

**Status: completed via `vercel.json` — the dashboard steps below are no longer required.** They are kept
only as a reference for projects that override configuration in the dashboard, and as the recommended
check whenever a build misbehaves. On the legacy project
(`vercel.com/obiorachibuikes-projects/novel-forge`):

1. **Settings → Build & Development Settings**
   * Framework Preset: **Next.js**
   * Build Command: clear the override (default `npm run build` → `next build`)
   * Output Directory: clear the override (default `.next` — do **not** keep `dist`)
   * Install Command: `npm ci`
   * Root Directory: repository root
2. **Settings → General → Node.js Version:** **22.x**
3. **Deployments → latest failed deployment → ⋯ → Redeploy**, with **"Use existing build cache"
   unchecked** (stale cache from the Vite/Prisma era should not be reused).
4. Verify the new deployment goes green on `main`.

Alternative, if a project is superseded: **Settings → Git → Disconnect** on it so merges stop producing
extra checks, and keep one project as the deployment target. There are currently **three** projects linked
to this repository (`novel-forge`, `novel-forge-hvkj`, `novel-forge-v9b1`), which triples every deploy,
scatters environment variables and can leave different projects owning different domains — consolidating
to one is worth doing. Do this **only after** confirming which project holds the production domains and
environment variables.

## Secondary observations (not the cause, but worth knowing)

* **`better-sqlite3@13` ships no prebuilt binaries.** The `v13.0.3` release has 0 assets (v12.4.1 has 110,
  including `node-v127-linux-x64` for Node 22), and the package declares no install script — so every
  `npm ci` compiles SQLite from source and needs the build image's toolchain plus node-gyp headers from
  `nodejs.org`. That makes installs slower and more fragile than necessary. Pinning `better-sqlite3@^12`
  or moving to a serverless-friendly database removes that fragility. It is not related to the failing
  deployment: the legacy project fails before this matters, and `novel-forge-hvkj` builds fine with it.
* **Runtime persistence on Vercel is still unsolved by design** — SQLite on local disk, uploads under
  `public/uploads`, and the in-process queue do not survive serverless execution. This is already
  documented in the README after PR #3; it affects the deployed app's behaviour, not the build.
