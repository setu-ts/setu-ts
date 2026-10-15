import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

interface WebsiteScripts {
  readonly build: string;
  readonly dev: string;
  readonly preview: string;
  readonly test: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWebsiteScripts(value: unknown): value is WebsiteScripts {
  return (
    isRecord(value) &&
    [value.build, value.dev, value.preview, value.test].every(
      (script: unknown): script is string => typeof script === 'string',
    )
  );
}

async function readWebsiteScripts(): Promise<WebsiteScripts> {
  const manifestUrl = new URL('../package.json', import.meta.url);
  const manifest: unknown = JSON.parse(await readFile(manifestUrl, 'utf8'));

  if (!isRecord(manifest) || !isWebsiteScripts(manifest.scripts)) {
    throw new Error(
      'website/package.json must define string dev, build, preview, and test scripts',
    );
  }

  return manifest.scripts;
}

it('builds the API reference from HEAD, then the site, then grafts and indexes it', async () => {
  const { build } = await readWebsiteScripts();
  const steps = [
    'node scripts/generate-api-docs.ts',
    'astro build',
    'node scripts/graft.mjs',
    'pagefind --site dist',
  ].map((step) => build.indexOf(step));

  // Every step is present, and each runs after the one before it: the graft copies the
  // generated reference into Astro's output, and Pagefind indexes the finished `dist`.
  expect(steps.every((index) => index >= 0)).toBe(true);
  expect(steps).toEqual([...steps].sort((a, b) => a - b));
});

it('runs every website tool on Node, never through Deno', async () => {
  const scripts = await readWebsiteScripts();

  for (const script of Object.values(scripts)) {
    expect(script).not.toMatch(/\bdeno\b/);
  }
});
