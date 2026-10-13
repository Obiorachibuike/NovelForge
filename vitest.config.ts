import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // The Next.js marker package throws when imported outside a server
      // component; tests import the same modules directly.
      'server-only': path.resolve(__dirname, 'node_modules/server-only/empty.js'),
      // `next-auth` imports the extension-less Next entrypoints, which Node's
      // resolver cannot find outside the Next bundler.
      'next/server': path.resolve(__dirname, 'node_modules/next/server.js'),
      'next/headers': path.resolve(__dirname, 'node_modules/next/headers.js'),
      'next/navigation': path.resolve(__dirname, 'node_modules/next/navigation.js'),
      'next/cache': path.resolve(__dirname, 'node_modules/next/cache.js'),
    },
  },
  test: {
    environment: 'node',
    server: {
      deps: {
        // Processed (not externalised) so the `next/*` aliases above apply to
        // `next-auth`'s extension-less Next.js imports.
        inline: ['next-auth', '@auth/core'],
      },
    },
    globals: true,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Each worker gets its own SQLite file (see tests/setup.ts); keep files
    // serial inside a worker to avoid cross-test interference.
    fileParallelism: true,
    restoreMocks: true,
    reporters: ['default'],
  },
});
