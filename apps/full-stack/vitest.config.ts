import { defineConfig } from 'vitest/config';
import { sourceExport } from '../../scripts/codemods/workspace-sources.ts';

export default defineConfig({
  plugins: [{ name: 'workspace-source', enforce: 'pre', resolveId: sourceExport }],
  test: { include: ['test/**/*.test.ts'] },
});
