import { expect } from '@std/expect';

interface WebsiteTasks {
  readonly build: string;
  readonly dev: string;
  readonly preview: string;
}

interface WebsiteConfig {
  readonly tasks: WebsiteTasks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWebsiteConfig(value: unknown): value is WebsiteConfig {
  if (!isRecord(value) || !isRecord(value.tasks)) {
    return false;
  }

  return [value.tasks.build, value.tasks.dev, value.tasks.preview].every(
    (task: unknown): task is string => typeof task === 'string',
  );
}

async function readWebsiteConfig(): Promise<WebsiteConfig> {
  const configUrl = new URL('../deno.json', import.meta.url);
  const config: unknown = JSON.parse(await Deno.readTextFile(configUrl));

  if (!isWebsiteConfig(config)) {
    throw new Error(
      'website/deno.json must define string dev, build, and preview tasks',
    );
  }

  return config;
}

Deno.test('website tools use Node to resolve transitive npm dependencies', async () => {
  const { tasks } = await readWebsiteConfig();

  expect(tasks.dev).toContain('node node_modules/astro/astro.js dev');
  expect(tasks.build).toContain('node node_modules/astro/astro.js build');
  expect(tasks.build).toContain(
    'node node_modules/pagefind/lib/runner/bin.cjs --site dist',
  );
  expect(tasks.preview).toContain('node node_modules/astro/astro.js preview');
  expect(tasks.build).not.toContain('deno run -A npm:astro');
});
