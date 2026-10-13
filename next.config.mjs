/** @type {import('next').NextConfig} */
const nextConfig = {
  // Type and lint errors are NOT ignored: `npm run build` must fail on a real
  // regression. Run `npm run typecheck` and `npm run lint` for the same checks
  // without producing a build. (Previously both were skipped, which hid 17
  // pre-existing type errors.)
  reactStrictMode: true,
  images: {
    /**
     * Covers and exports are served by the ownership-checked /api/files route,
     * which the optimizer cannot call on a visitor's behalf (no session cookie),
     * so optimisation is disabled and next/image renders the authenticated URL
     * directly. This also removes the Image Optimization API from the attack
     * surface (see the Next.js advisories tracked in
     * docs/production-readiness-audit.md §9.14).
     */
    unoptimized: true,
    remotePatterns: [
      { protocol: 'https', hostname: 'res.cloudinary.com' },
      { protocol: 'https', hostname: 'oaidalleapiprodscus.blob.core.windows.net' },
      { protocol: 'https', hostname: 'images.unsplash.com' },
    ],
  },
  experimental: {
    // Route handlers enforce their own, per-endpoint body limits (see
    // src/lib/api/http.ts); this stays for server actions only.
    serverActions: { bodySizeLimit: '10mb' },
    // better-sqlite3 (and the pg/ioredis drivers used by optional modes) are
    // native/CJS packages that must not be bundled.
    serverComponentsExternalPackages: ['better-sqlite3', 'bullmq', 'ioredis'],
  },
};

export default nextConfig;
