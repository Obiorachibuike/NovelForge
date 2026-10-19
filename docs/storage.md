# Storage & Cloudinary Cover-Image Workflow

NovelForge uses **Cloudinary** as the permanent storage provider for user-selected AI-generated novel cover images (`src/services/covers/cloudinary-cover-service.ts`), while keeping unselected cover candidate variations temporary so provider storage is never polluted with discarded drafts.

---

## 1. Environment Variables

Configure these server-only environment variables in `.env.local` or your deployment secret manager (never prefix `CLOUDINARY_API_SECRET` with `NEXT_PUBLIC_`):

```env
STORAGE_PROVIDER="cloudinary"
CLOUDINARY_CLOUD_NAME="your-cloud-name"
CLOUDINARY_API_KEY="your-cloudinary-api-key"
CLOUDINARY_API_SECRET="your-cloudinary-api-secret"
CLOUDINARY_FOLDER="novelforge"
```

---

## 2. Folder & Public ID Convention

Every permanently saved novel cover is stored in Cloudinary under a predictable user-and-novel-scoped namespace:

- **Folder**: `novelforge/covers/<user-id>/<novel-id>`
- **Public ID**: `novelforge/covers/<user-id>/<novel-id>/cover_<image-id>`

This scoping guarantees that `deleteCloudinaryCover()` can verify ownership (`publicId.startsWith('novelforge/covers/<userId>/<novelId>/')`) before issuing a signed destroy request, preventing any cross-user asset deletion.

---

## 3. Image Content Validation

Before any cover image is stored or uploaded to Cloudinary, `validateCoverImageBuffer()` in `src/services/covers/cloudinary-cover-service.ts`:
1. Enforces a strict maximum size limit (`MAX_COVER_IMAGE_BYTES = 10 MB`).
2. Inspects the actual binary magic bytes / XML structure rather than trusting file extensions or MIME headers:
   - **PNG**: `89 50 4E 47 0D 0A 1A 0A` (and extracts IHDR width/height)
   - **JPEG**: `FF D8 FF`
   - **WebP**: `RIFF....WEBP`
   - **SVG**: Valid `<svg>...</svg>` XML without `<script>` tags or `on*=` inline event handlers.

---

## 4. End-to-End 10-Step Cover Selection Workflow

1. **User creates or opens a novel** (`/novels/[id]/cover`).
2. **User generates cover image options** (`POST /api/novels/[id]/cover`):
   - `generateCovers()` generates 1–4 candidate variations (via OpenAI `dall-e-3` or stylized SVG concepts in demo mode).
   - When `STORAGE_PROVIDER="cloudinary"`, candidate previews are saved to temporary local candidate storage via `saveCandidateCoverPreview()` — **unselected variations are NOT uploaded to Cloudinary**.
3. **Frontend displays generated cover candidates** (`CoverStudio.tsx`).
4. **User selects the preferred cover** (`PUT /api/novels/[id]/cover` with `{ imageId }`).
5. **Backend verifies ownership** (`setCover()` in `src/services/novels/service.ts` verifies that the authenticated user owns both the novel and the `image_assets` row).
6. **Backend uploads the selected image to Cloudinary** (`uploadCoverToCloudinary()` signs and uploads the validated buffer to `novelforge/covers/<userId>/<novelId>/cover_<imageId>`).
7. **Backend saves Cloudinary metadata in the database** (`secureUrl`, `publicId`, `format`, `bytes`, `folder`, `width`, `height`, `uploadedAt`, `updatedAt` in `image_assets`).
8. **Backend updates the novel record** (`novels.coverImageId = imageId`) inside the same database transaction:
   - **Rollback Cleanup**: If the database transaction fails after the Cloudinary upload succeeded, `setCover()` immediately calls `deleteCloudinaryCover(uploaded.publicId)` so no orphaned Cloudinary asset remains.
   - **Replacement Cleanup**: If the novel previously had a different primary cover stored in Cloudinary, `setCover()` calls `deleteCloudinaryCover(previousPrimary.publicId)` after the DB commit.
9. **Frontend refreshes and displays the saved cover** (`CoverStudio.tsx` displays `c.secureUrl || c.url`, shows a `Cloudinary` badge, and provides an inline **Retry** button if an upload fails).
10. **Permanent cover persists** across page refreshes, sign-outs/sign-ins, dashboard views (`COALESCE(img.secureUrl, img.url) AS coverUrl`), backups, and deployments.
