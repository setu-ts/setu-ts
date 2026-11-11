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
  // Read escaped quotes in the Node existence check as JSON, rather than
  // truncating a script at its first embedded quote.
  return raw === '' ? {} : (JSON.parse(raw) as { scripts: Record<string, string> }).scripts;
}

describe('generated local start scripts load .env (M131a X88-2)', () => {
  it.each(['node', 'bun', 'deno'] as const)(
    'V12-24 prints a startup banner on %s only when needed',
    async (runtime) => {
      const h = harness();
      expect(await h.run(['new', 'svc', '--template', 'full-stack', '--runtime', runtime])).toBe(0);
      for (const file of ['main.ts', 'dev.ts']) {
        const entry = h.fs.read(`/work/svc/${file}`);
        expect(entry.includes('Listening on http://localhost:')).toBe(runtime !== 'deno');
        if (runtime !== 'deno')
          expect(entry.indexOf('Listening on')).toBeGreaterThan(entry.indexOf('await app.start'));
      }
    },
  );
  it('V12-48 catches Vite setup failures and names the standalone or workspace remedy', async () => {
    const { renderFullStackDevEntry } =
      await import('../../src/templates/full-stack-build-files.ts');
    for (const port of [undefined, { symbol: 'PORT', from: './src/discovery/index.ts' }]) {
      const entry = renderFullStackDevEntry(port).contents;
      expect(entry).toContain('try {\n  server = await vite.createServer');
      expect(entry).toContain('await server?.close();');
      expect(entry).toContain(
        'Startup failed: Vite could not listen on ${vitePort} (VITE_PORT): ${describeError(error)}',
      );
      expect(entry).toContain(
        port === undefined ? 'Choose another VITE_PORT' : 'setu.workspace.json',
      );
    }
  });
  it('Node local scripts carry --env-file-if-exists=.env; production does not', async () => {
    const h = harness();
    await h.run(['new', 'svc', '--template', 'rest', '--runtime', 'node']);
    const scripts = readScripts(h, '/work/svc/package.json');
    expect(scripts['start'] ?? '').toContain('--env-file-if-exists=.env');
    expect(scripts['start:dev'] ?? '').toContain('--env-file-if-exists=.env');
    expect(scripts['start:debug'] ?? '').toContain('--env-file-if-exists=.env');
    // tsx reads its subcommand from the first argument, so the flags follow
    // `watch`: `tsx --env-file-if-exists=.env watch main.ts` runs a file named
    // `watch` (measured, tsx 4.23).
    expect(scripts['start:dev']).toMatch(/^tsx watch --/);
    // The production image runs the entry directly, never `npm start`, so it
    // keeps the platform environment and passes no flag.
    const dockerfile = safeRead(h, '/work/svc/Dockerfile');
    expect(dockerfile).toContain('CMD [');
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

  it('a workspace member image carries no env-file flag', async () => {
    const h = harness();
    await h.run(['new', 'ws', '--workspace', '--runtime', 'node']);
    expect(await h.run(['generate', 'app', 'svc', '--dir', '/work/ws'])).toBe(0);
    const dockerfile = safeRead(h, '/work/ws/docker/Dockerfile');
    expect(dockerfile).toContain('CMD [');
    expect(dockerfile).not.toContain('--env-file');
  });

  it('the full-stack dev entry fails to start with one masked line (X88-8)', async () => {
    const { renderFullStackDevEntry } =
      await import('../../src/templates/full-stack-build-files.ts');
    expect(renderFullStackDevEntry().contents).toContain(
      'console.error(`Startup failed: ${describeError(error)}`);',
    );
    expect(renderFullStackDevEntry().contents).toContain('await viteServer.close();');
    expect(renderFullStackDevEntry().contents).toContain('return runtime.exit(1);');
  });

  it.each([
    ['node', '--env-file-if-exists=local.env'],
    ['bun', '--env-file=local.env'],
  ] as const)(
    '%s scripts load a configured --env-file path (CodeRabbit #543)',
    async (runtime, flag) => {
      const h = harness();
      expect(
        await h.run([
          'new',
          'svc',
          '--template',
          'rest',
          '--runtime',
          runtime,
          '--env-file',
          'local.env',
        ]),
      ).toBe(0);
      const scripts = readScripts(h, '/work/svc/package.json');
      for (const name of ['start', 'start:dev', 'start:debug']) {
        expect(scripts[name], name).toContain(flag);
        expect(scripts[name], name).not.toContain('=.env ');
      }
    },
  );
});
