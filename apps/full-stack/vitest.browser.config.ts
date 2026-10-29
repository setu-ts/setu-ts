import { defineConfig } from 'vitest/config';
import { sourceExport } from '../../scripts/codemods/workspace-sources.ts';

export default defineConfig({
  plugins: [{ name: 'workspace-source', enforce: 'pre', resolveId: sourceExport }],
  test: {
    fileParallelism: false,
    include: ['browser/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 900_000,
  },
});
