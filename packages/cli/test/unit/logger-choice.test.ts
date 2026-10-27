import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.ts';
import { parseArgs } from '../../src/args.ts';
import { resolveNewChoices } from '../../src/commands/new-interactive.ts';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import loggerManifest from '../../../logger-plugin/package.json' with { type: 'json' };

function harness() {
  const fs = createFakeFs();
  const out = createRecorder();
  const err = createRecorder();
  return {
    fs,
    out,
    err,
    run: (argv: readonly string[]) =>
      runCli(argv, { fs, cwd: '/work', now: () => 0, log: out.sink, error: err.sink }),
  };
}

describe('scaffold logger choice', () => {
  for (const template of ['rest', 'microservice', 'class-based', 'full-stack']) {
    for (const runtime of ['node', 'deno', 'bun', 'cloudflare-workers']) {
      for (const selected of [
        undefined,
        'console',
        ...(runtime === 'cloudflare-workers' ? [] : ['pino']),
      ]) {
        it(`${template} on ${runtime} with ${selected ?? 'the default'} renders the expected transport and dependency`, async () => {
          const h = harness();
          expect(
            await h.run([
              'new',
              'svc',
              '--template',
              template,
              '--runtime',
              runtime,
              ...(selected === undefined ? [] : ['--logger', selected]),
            ]),
            h.err.text(),
          ).toBe(0);
          const pino =
            selected === 'pino' || (selected === undefined && runtime !== 'cloudflare-workers');
          expect(h.fs.read('/work/svc/setu.config.ts')).toContain(
            `transport: '${pino ? 'pino' : 'console'}'`,
          );
          const manifest = h.fs.read(
            `/work/svc/${runtime === 'deno' ? 'deno.json' : 'package.json'}`,
          );
          const parsed = JSON.parse(manifest) as {
            dependencies?: Record<string, string>;
            imports?: Record<string, string>;
          };
          expect(
            runtime === 'deno' ? parsed.imports?.['pino'] : parsed.dependencies?.['pino'],
          ).toBe(
            pino
              ? runtime === 'deno'
                ? `npm:pino@${loggerManifest.peerDependencies.pino}`
                : loggerManifest.peerDependencies.pino
              : undefined,
          );
        });
      }
    }
  }

  for (const logger of ['console', 'pino']) {
    it(`threads explicit --logger ${logger} into a styled template and workspace member`, async () => {
      const h = harness();
      expect(await h.run(['new', 'mono', '--workspace'])).toBe(0);
      expect(
        await h.run([
          'generate',
          'app',
          'svc',
          '--dir',
          '/work/mono',
          '--template',
          'rest',
          '--style',
          'class-based',
          '--logger',
          logger,
        ]),
        h.err.text(),
      ).toBe(0);
      expect(h.fs.read('/work/mono/apps/svc/setu.config.ts')).toContain(`transport: '${logger}'`);
      const manifest = JSON.parse(h.fs.read('/work/mono/apps/svc/package.json')) as {
        dependencies: Record<string, string>;
      };
      expect(manifest.dependencies['pino']).toBe(
        logger === 'pino' ? loggerManifest.peerDependencies.pino : undefined,
      );
    });
  }

  for (const value of ['invalid', 'constructor', '__proto__', undefined]) {
    it(`refuses --logger ${value ?? '(missing)'} before writing`, async () => {
      const h = harness();
      expect(
        await h.run([
          'new',
          'svc',
          '--template',
          'rest',
          '--logger',
          ...(value === undefined ? [] : [value]),
        ]),
      ).toBe(2);
      expect(h.err.text()).toContain('--logger');
      expect(h.err.text()).toContain(
        value === undefined ? 'needs a value' : `Unknown --logger "${value}"`,
      );
      expect(h.fs.writes).toEqual([]);
    });
  }

  it('refuses pino on Workers by name and refuses a logger on hosts without logging', async () => {
    for (const [flags, message] of [
      [
        ['--template', 'rest', '--runtime', 'cloudflare-workers', '--logger', 'pino'],
        'unavailable on Cloudflare Workers',
      ],
      [['--logger', 'pino'], 'nothing to configure'],
      [['--workspace', '--logger', 'console'], 'applies to an application'],
    ] as const) {
      const h = harness();
      expect(await h.run(['new', 'svc', ...flags])).toBe(2);
      expect(h.err.text()).toContain('--logger');
      expect(h.err.text()).toContain(message);
      expect(h.fs.writes).toEqual([]);
    }
  });

  it('reports logger in dry-run and help without writing', async () => {
    const h = harness();
    expect(await h.run(['new', 'svc', '--template', 'rest', '--dry-run'])).toBe(0);
    expect(h.out.text()).toContain('Logger: pino');
    expect(h.fs.writes).toEqual([]);
    expect(await h.run(['new', '--help'])).toBe(0);
    expect(h.out.text()).toContain('--logger <name>');
    expect(await h.run(['generate', 'app', '--help'])).toBe(0);
    expect(h.out.text().match(/--logger <name>/g)).toHaveLength(2);
    expect(await h.run(['new', 'mono', '--workspace'])).toBe(0);
    const writes = h.fs.writes.length;
    expect(
      await h.run([
        'generate',
        'app',
        'svc',
        '--template',
        'rest',
        '--logger',
        'console',
        '--dir',
        '/work/mono',
        '--dry-run',
      ]),
    ).toBe(0);
    expect(h.out.text()).toContain('Logger: console');
    expect(h.fs.writes).toHaveLength(writes);
  });

  for (const runtime of ['node', 'deno', 'bun', 'cloudflare-workers']) {
    it(`asks the logger prompt with the ${runtime} default first`, async () => {
      const menus = new Map<string, readonly string[]>();
      const resolved = await resolveNewChoices(
        parseArgs(['svc', '--runtime', runtime, '--template', 'full-stack']),
        {
          select(question, choices) {
            menus.set(
              question,
              choices.map((choice) => choice.value),
            );
            return Promise.resolve({ kind: 'answer', value: choices[0]!.value });
          },
        },
        () => {},
      );
      expect(menus.get('Logger?')).toEqual(
        runtime === 'cloudflare-workers' ? ['console'] : ['pino', 'console'],
      );
      expect(resolved.kind === 'resolved' && resolved.args.flags['logger']).toBe(
        runtime === 'cloudflare-workers' ? 'console' : 'pino',
      );
    });
  }
});
