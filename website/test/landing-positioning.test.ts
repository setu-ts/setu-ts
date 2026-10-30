import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('landing page foregrounds that Setu-TS is built on Hono', async () => {
  const pageUrl = new URL('../src/pages/index.astro', import.meta.url);
  const page = await readFile(pageUrl, 'utf8');

  expect(page).toContain('Built on Hono');
  expect(page).toContain("Hono's performance and runtime portability");
  expect(page).toContain('npm create @setu-ts');
});
