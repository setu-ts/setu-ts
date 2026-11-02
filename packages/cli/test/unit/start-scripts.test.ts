/**
 * Generated local start scripts load `.env` through the runtime (M131a X88-2):
 * Node `--env-file-if-exists=.env`, Deno `--env-file=.env`, Bun loads `.env`
 * itself. Production images and Compose keep the platform environment and pass
 * no flag — the image `CMD` runs the entry directly, never `npm start` — so a
 * local script's flag cannot reach a container.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import { runCli } from '../../src/cli.ts';

function harness() {
  const fs = createFakeFs();
  const errors: string[] = [];
  return {
    fs,
    errors,
    run: (args: readonly string[]) =>
      runCli(args, {
        fs,
        cwd: '/work',
        now: () => 0,
        log: () => {},
        error: (line) => errors.push(line),
      }),
  };
}

function safeRead(h: ReturnType<typeof harness>, file: string): string {
  try {
    return h.fs.read(file);
  } catch {
    return '';
  }
}

function readScripts(h: ReturnType<typeof harness>, file: string): Record<string, string> {
  const raw = safeRead(h, file);
  // The scripts block is a flat `"<name>": "<cmd>"` map; read each line.
  const scripts: Record<string, string> = {};
  for (const match of raw.matchAll(/"([a-z:]+)"\s*:\s*"([^"]+)"/g)) {
    scripts[match[1]!] = match[2]!;
  }
  return scripts;
}

describe('generated local start scripts load .env (M131a X88-2)', () => {
  it('Node local scripts carry --env-file-if-exists=.env; production does not', async () => {
    const h = harness();
    await h.run(['new', 'svc', '--template', 'rest', '--runtime', 'node']);
    const scripts = readScripts(h, '/work/svc/package.json');
    expect(scripts['start'] ?? '').toContain('--env-file-if-exists=.env');
    expect(scripts['start:dev'] ?? '').toContain('--env-file-if-exists=.env');
    expect(scripts['start:debug'] ?? '').toContain('--env-file-if-exists=.env');
    // The production image runs the entry directly, never `npm start`, so it
    // keeps the platform environment and passes no flag.
    const dockerfile = safeRead(h, '/work/svc/Dockerfile');
    expect(dockerfile).not.toContain('--env-file');
  });

  it('Bun local scripts carry no flag (Bun loads .env itself)', async () => {
    const h = harness();
    await h.run(['new', 'svc', '--template', 'rest', '--runtime', 'bun']);
    const scripts = readScripts(h, '/work/svc/package.json');
    expect(scripts['start'] ?? '').not.toContain('--env-file');
    expect(scripts['start:dev'] ?? '').not.toContain('--env-file');
  });

  it('Deno local scripts carry --env-file=.env when the manifest writes a dotenv', async () => {
    const h = harness();
    await h.run(['new', 'svc', '--template', 'full-stack', '--runtime', 'deno']);
    const deno = safeRead(h, '/work/svc/deno.json');
    expect(deno).toContain('--env-file=.env');
  });

  it('Compose commands carry no env-file flag', async () => {
    const h = harness();
    await h.run(['new', 'svc', '--template', 'rest', '--runtime', 'node']);
    const compose = safeRead(h, '/work/svc/docker/compose.yaml');
    expect(compose).not.toContain('--env-file');
  });
});
