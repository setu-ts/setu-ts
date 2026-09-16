import { expect } from '@std/expect';

Deno.test('landing page foregrounds that Setu-TS is built on Hono', async () => {
  const pageUrl = new URL('../src/pages/index.astro', import.meta.url);
  const page = await Deno.readTextFile(pageUrl);

  expect(page).toContain('Built on Hono');
  expect(page).toContain("Hono's performance and runtime portability");
});
