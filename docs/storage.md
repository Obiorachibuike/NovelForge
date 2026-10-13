# Persistent storage

NovelForge writes two kinds of generated file:

| Artefact | Folder prefix | Notes |
| --- | --- | --- |
| Cover concepts (PNG/JPG from the image provider, SVG demo/fallback) | `covers/` | up to 24 concepts per novel |
| Exports (`.txt`, `.md`, `.docx`, `.pdf`, `.epub`) | `exports/` | written by the `export` job |

Every file is recorded in the database (`image_assets.storageKey`,
`exports.fileKey`) and downloaded through `GET /api/files/<key>`, which resolves
the row and checks that the caller owns it. Nothing is served from `public/`
any more, so cover and manuscript URLs are private by default.

## Choosing a driver

```
STORAGE_PROVIDER=local | s3 | cloudinary
```

* **`local`** (default) — `<DATA_DIR>/uploads/<key>`, where `DATA_DIR` defaults
  to `./.data`. Works for local development and a single long-lived server.
  Files written by older versions into `public/uploads` are moved into the new
  location on first use and their URLs are rewritten in the database.
  `local` deliberately throws on Vercel: the filesystem there is ephemeral and
  a redeploy would silently lose every cover and export.
* **`s3`** — any S3-compatible object store. Implemented in-process with a
  dependency-free AWS Signature V4 signer (`src/lib/storage/s3-signature.ts`),
  verified against the published AWS test vector in
  `tests/storage/sigv4.test.ts`.
* **`cloudinary`** — image uploads only. Exports cannot be stored on Cloudinary,
  so `cloudinary` is rejected for export files. *This driver has not been
  exercised against a live Cloudinary account in this repository.*

## S3 / R2 / B2 / MinIO configuration

```
STORAGE_PROVIDER=s3
S3_BUCKET=my-novelforge-bucket
S3_REGION=eu-central-1
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
# Optional
S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com   # non-AWS only
S3_FORCE_PATH_STYLE=true                                   # required by MinIO/B2
S3_PREFIX=novelforge                                        # key prefix in the bucket
S3_PUBLIC_BASE_URL=https://cdn.example.com                  # only if you front the bucket with a CDN
```

Startup behaviour: `readS3Config()` throws
`S3 storage is selected but S3_BUCKET, … is not set. See docs/storage.md.`
as soon as a save/read is attempted, so a half-configured deployment fails
loudly instead of dropping files.

Objects are uploaded with a signed `PUT` and a `content-type`; reads and deletes
are signed the same way. With `S3_PREFIX`, every object lives under that prefix.

## Verifying a deployment

1. Generate a cover concept; the response contains `url: /api/files/covers/...`.
2. Confirm the object exists in the bucket under the configured prefix.
3. Restart the app (or redeploy) and download the same URL again — it must still
   resolve, because both the row and the object are outside the instance.
4. Try the URL while signed in as a different user: it must return 404.

## Tests

```
npx vitest run tests/storage
```

`tests/storage/s3-driver.test.ts` runs the real driver against a local
S3-shaped HTTP server and asserts the signed request, the object path (bucket +
prefix), read-back, delete, CDN URL rewriting and the missing-credential error.
`tests/storage/sigv4.test.ts` checks the signer against AWS's documented
`GET Object` example (`f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`).
