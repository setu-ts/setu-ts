import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

/**
 * Vite builds the client bundle and the server build; it does NOT serve the
 * application. The framework owns the server, so `vite build` is a build step
 * and `main.ts` is the runtime.
 *
 * `resolve.tsconfigPaths` is what makes the `~/*` alias work at build time; the
 * same alias is declared in `tsconfig.json` for the type-checker.
 */
// Framework packages stay external, resolved here by tsx through this app's
// tsconfig paths. Bundling would inline a second copy: the context keys in
// app/lib/context-keys.server.ts match by identity, so loaders must share the
// module instance setu.config.ts holds.
const frameworkPackages = [
  '@setu-ts/common',
  '@setu-ts/database-plugin',
  '@setu-ts/react-router-plugin',
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
