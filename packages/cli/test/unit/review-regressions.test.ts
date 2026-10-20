import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/args.ts';
import { runGenerateCommand } from '../../src/commands/generate.ts';
import { runNewCommand } from '../../src/commands/new.ts';
import { runCli } from '../../src/cli.ts';
import { runAddCommand } from '../../src/commands/add.ts';
import { mergeObjectArgs, wrapPluginArgs } from '../../src/templates/plugin-args.ts';
import { projectFiles, resolveHost } from '../../src/templates/project-files.ts';
import { getTemplate } from '../../src/templates/registry.ts';
import { VERSION } from '../../src/version.ts';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('M113i review regressions', () => {
  for (const runtime of [undefined, 'deno', 'node', 'bun'] as const) {
    it(`keeps help and unresolved-runtime remedies neutral for ${runtime ?? 'no project'}`, async () => {
      const fs = createFakeFs(
        runtime === undefined
          ? {}
          : runtime === 'deno'
            ? { '/app/deno.json': '{}' }
            : { '/app/package.json': JSON.stringify({ setu: { runtime } }) },
      );
      for (const argv of [
        ['--help'],
        ['add'],
        ['add', '--help'],
        ['new', '--help'],
        ['adopt', '--help'],
        ['generate', 'app', '--help'],
        ['generate', 'library', '--help'],
        ['generate', 'custom'],
        ['generate', 'service'],
        ['generate', '--help'],
        ['workspace', '--help'],
        ['workspace', 'bogus'],
      ]) {
        const out = createRecorder();
        const error = createRecorder();
        await runCli(argv, { fs, cwd: '/app', now: () => 0, log: out.sink, error: error.sink });
        const text = `${out.text()}\n${error.text()}`;
        expect(text, argv.join(' ')).toContain('Usage: setu ');
        expect(text, argv.join(' ')).not.toContain(`@setu-ts/cli@${VERSION}`);
      }
      const error = createRecorder();
      expect(
        await runCli(['commands'], {
          fs,
          cwd: '/app',
          now: () => 0,
          log: () => {},
          error: error.sink,
        }),
      ).toBe(2);
      expect(error.text()).toContain('Scaffold one with `setu new`');
    });
  }

  it('accepts quoted braces, commas and escaped quotes in object arguments', () => {
    for (const quote of ["'", '"', '`']) {
      for (const value of ['redis://:p{a}ss@127.0.0.1:6379', `a\\${quote},{b}\\\\c`]) {
        const body = `url: ${quote}${value}${quote}`;
        expect(mergeObjectArgs(`{ ${body}, }`, '{ processors: [] }')).toBe(
          `{ ${body}, processors: [] }`,
        );
        const padding = 'paddingForWrapping: true';
        expect(wrapPluginArgs(`{ ${body}, ${padding}, extraPadding: true }`)).toContain(
          `        ${body},\n`,
        );
      }
      expect(() => mergeObjectArgs(`{ url: ${quote}unterminated }`, '{}')).toThrow();
      expect(() => mergeObjectArgs(`{ url: ${quote}ok${quote}, nested: {} }`, '{}')).toThrow();
    }
  });

  it('generates a microservice app using a workspace transport URL with braces', async () => {
    const fs = createFakeFs();
    const out = createRecorder();
    const error = createRecorder();
    const deps = { fs, cwd: '/work', now: () => 0, log: out.sink, error: error.sink };
    const url = 'redis://:p{a}ss@127.0.0.1:6379';
    expect(
      await runNewCommand(
        parseArgs([
          'acme',
          '--workspace',
          '--runtime',
          'deno',
          '--transport',
          'redis',
          '--transport-url',
          url,
        ]),
        deps,
      ),
    ).toBe(0);
    expect(
      await runCli(['g', 'app', 'orders', '--template', 'microservice'], {
        ...deps,
        cwd: '/work/acme',
      }),
    ).toBe(0);
    const config = fs.read('/work/acme/apps/orders/setu.config.ts');
    expect(config).toContain(url);
    expect(config).toContain("adapter: 'redis'");
    expect(config).toContain('processors: [...QUEUE_PROCESSORS]');
  });

  it('refuses a directory at new main.ts without reading it in a dry run', async () => {
    await mkdir('.tmp', { recursive: true });
    const cwd = await mkdtemp(resolve('.tmp/review-directory-'));
    temporary.push(cwd);
    await mkdir(`${cwd}/app/main.ts`, { recursive: true });
    const out = createRecorder();
    const error = createRecorder();
    expect(
      await runNewCommand(parseArgs(['app', '--dry-run']), {
        fs: createNodeRuntimeServices().fs!,
        cwd,
        log: out.sink,
        error: error.sink,
      }),
    ).toBe(1);
    expect(error.text()).toContain(`WOULD REFUSE: ${cwd}/app/main.ts already exists`);
  });

  it('classifies formatted managed custom output identically in dry and real runs', async () => {
    const fs = createFakeFs({
      '/app/package.json': '{"setu":{"runtime":"node"}}',
      '/app/src/custom.ts': 'export const value = 1;\n',
    });
    const load = () =>
      Promise.resolve({
        default: () => [
          {
            path: 'src/custom.ts',
            contents: 'export const value=1',
            managed: true,
          },
        ],
      });
    for (const flags of [['--dry-run'], []]) {
      const out = createRecorder();
      const error = createRecorder();
      expect(
        await runGenerateCommand(parseArgs(['custom', 'example', 'widget', ...flags]), {
          fs,
          cwd: '/app',
          now: () => 0,
          log: out.sink,
          error: error.sink,
          load,
        }),
      ).toBe(0);
      expect(out.text()).toContain('unchanged /app/src/custom.ts');
      expect(fs.read('/app/src/custom.ts')).toBe('export const value = 1;\n');
    }
  });

  for (const [runtime, invocation] of [
    ['deno', `deno run -A npm:@setu-ts/cli@${VERSION}`],
    ['node', `npx @setu-ts/cli@${VERSION}`],
    ['bun', `bunx @setu-ts/cli@${VERSION}`],
    ['cloudflare-workers', `npx @setu-ts/cli@${VERSION}`],
  ] as const) {
    it(`pins Deno-only diagnostics refusal for ${runtime}`, async () => {
      const fs = createFakeFs(
        runtime === 'deno'
          ? { '/app/deno.json': '{}' }
          : {
              '/app/package.json': JSON.stringify({ scripts: { start: `${runtime} main.ts` } }),
            },
      );
      const error = createRecorder();
      expect(
        await runAddCommand(parseArgs(['diagnostics']), {
          fs,
          cwd: '/app',
          log: () => {},
          error: error.sink,
        }),
      ).toBe(2);
      expect(error.text()).toContain(`\`deno run -A npm:@setu-ts/cli@${VERSION} devtool enable\``);
    });
    it(`pins generated middleware guidance for ${runtime}`, () => {
      const files = projectFiles('shop', runtime, resolveHost(getTemplate('full-stack')!, runtime));
      expect(
        files.find((file) => file.path === 'app/middleware/require-user.server.ts')!.contents,
      ).toContain(`\`${invocation} generate middleware <name>\``);
    });
  }
});
