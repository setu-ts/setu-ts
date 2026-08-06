import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

/**
 * Vite builds the client bundle and the server build; it does NOT serve the
 * application. The framework owns the server, so `vite build` is a build step
 * and `main.ts` is the runtime.
 *
 * `resolve.tsconfigPaths` is what makes the `~/*` alias work at build time; the
 * same alias is declared in `deno.json` for Deno's type-checker and in
 * `tsconfig.json` for this one.
 */
// Framework packages are NOT bundled into the server build. Two reasons, both
// load-bearing:
//
// 1. They are resolved by the SERVER runtime — here, through the `deno.json`
//    import map, which points them at this workspace's source. This npm
//    toolchain cannot resolve those paths at all.
// 2. Bundling would inline a second copy of each package, and the context keys
//    in app/lib/context-keys.server.ts are matched by identity: the copy
//    honoe.config.ts holds would stop matching the copy a loader reads, so
//    every context value would silently fall back to its default.
const frameworkPackages = [
  '@hono-enterprise/common',
  '@hono-enterprise/database-plugin',
  '@hono-enterprise/react-router-plugin',
];

export default defineConfig({
  plugins: [reactRouter()],
  resolve: { tsconfigPaths: true },
  // Declared per environment: React Router builds through Vite's Environment
  // API, and neither a top-level `ssr.external` nor
  // `environments.ssr.resolve.external` is applied to that build.
  environments: {
    ssr: { build: { rollupOptions: { external: frameworkPackages } } },
  },
});
