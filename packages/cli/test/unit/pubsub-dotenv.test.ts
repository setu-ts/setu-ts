import { expect, it } from 'vitest';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { runCli } from '../../src/cli.ts';
import { brokerSpec } from '../../src/workspace/transport.ts';
import { brokerEnvVariables } from '../../src/templates/broker.ts';

it('V13-143 declares the Pub/Sub project and emulator as separate env rows', () => {
  const rows = brokerEnvVariables(brokerSpec('pubsub'));
  expect(rows.map(({ name, develop }) => ({ name, develop }))).toEqual([
    { name: 'PUBSUB_PROJECT_ID', develop: 'setu-local' },
    { name: 'PUBSUB_EMULATOR_HOST', develop: '127.0.0.1:8085' },
  ]);
  expect(rows[1]?.description).toMatch(/authentication/);
});

it('V13-143 new and add write each Pub/Sub row with its own value and print the operational note', async () => {
  for (const add of [false, true]) {
    const fs = createFakeFs();
    const log = createRecorder();
    const deps = { fs, cwd: '/work', now: () => 0, log: log.sink, error: log.sink };
    expect(
      await runCli(
        [
          'new',
          'svc',
          '--template',
          add ? 'rest' : 'microservice',
          ...(add ? [] : ['--broker', 'pubsub']),
        ],
        deps,
      ),
      log.text(),
    ).toBe(0);
    if (add)
      expect(
        await runCli(['add', 'messaging', '--broker', 'pubsub', '--dir', '/work/svc'], deps),
        log.text(),
      ).toBe(0);
    expect(fs.read('/work/svc/.env')).toContain('PUBSUB_PROJECT_ID=setu-local\n');
    expect(fs.read('/work/svc/.env')).toContain('PUBSUB_EMULATOR_HOST=127.0.0.1:8085\n');
    expect(fs.read('/work/svc/.env.example')).toContain('PUBSUB_EMULATOR_HOST=\n');
    const note = brokerSpec('pubsub').connection!.note!;
    expect(note).toContain('local dotenv');
    expect(note).not.toContain('exporting');
    if (add) expect(log.lines).toContain(note);
    else
      expect(fs.read('/work/svc/README.md').replace(/\s+/g, ' ')).toContain(
        note.replace(/\s+/g, ' '),
      );
  }
});

it.each(['node', 'bun', 'deno'])(
  'V13-143 generated %s workspace members write only the broker emulator env row',
  async (runtime) => {
    for (const broker of ['pubsub', 'redis', 'memory']) {
      for (const style of ['functional', 'class-based']) {
        const fs = createFakeFs();
        const log = createRecorder();
        const deps = { fs, cwd: '/work', now: () => 0, log: log.sink, error: log.sink };
        expect(
          await runCli(
            ['new', 'ws', '--workspace', '--runtime', runtime, '--broker', broker],
            deps,
          ),
          log.text(),
        ).toBe(0);
        expect(
          await runCli(
            [
              'g',
              'app',
              'api',
              '--template',
              'microservice',
              '--style',
              style,
              '--dir',
              '/work/ws',
            ],
            deps,
          ),
          log.text(),
        ).toBe(0);
        const root = '/work/ws/apps/api';
        for (const suffix of ['', '.example']) {
          const env = fs.read(`${root}/.env${suffix}`);
          expect(env, `${broker} ${style} ${suffix}`).not.toContain('PUBSUB_PROJECT_ID=');
          if (broker === 'pubsub')
            expect(env).toContain(
              `PUBSUB_EMULATOR_HOST=${suffix === '' ? '127.0.0.1:8085' : ''}\n`,
            );
          else expect(env).not.toContain('PUBSUB_EMULATOR_HOST=');
        }
        if (broker === 'pubsub') {
          expect(fs.read(`${root}/src/transport/index.ts`)).toContain("'setu-local'");
        }
      }
    }
  },
);

it.each(['node', 'bun', 'deno', 'cloudflare-workers'] as const)(
  'V13-143 start and test scripts agree on the dotenv fragment for %s',
  async (runtime) => {
    for (const custom of [false, true]) {
      if (runtime === 'cloudflare-workers' && custom) continue;
      const fs = createFakeFs();
      const errors = createRecorder();
      const deps = { fs, cwd: '/work', now: () => 0, log: () => {}, error: errors.sink };
      const path = custom ? 'config/local.env' : '.env';
      expect(
        await runCli(
          [
            'new',
            'svc',
            '--template',
            'microservice',
            '--runtime',
            runtime,
            ...(custom ? ['--dotenv', path] : []),
          ],
          deps,
        ),
        errors.text(),
      ).toBe(0);
      const manifest = JSON.parse(
        fs.read(`/work/svc/${runtime === 'deno' ? 'deno.json' : 'package.json'}`),
      );
      const scripts: Record<string, string> = manifest[runtime === 'deno' ? 'tasks' : 'scripts'];
      const expected =
        runtime === 'node'
          ? `--env-file-if-exists=${path}`
          : runtime === 'deno' || (runtime === 'bun' && custom)
            ? `--env-file=${path}`
            : undefined;
      for (const name of ['start:dev', 'test', 'test:e2e']) {
        expect(scripts[name]?.match(/--env-file(?:-if-exists)?=\S+/)?.[0], name).toBe(expected);
      }
      expect(scripts.test).not.toContain('instrumentation.mjs');
      expect(scripts['test:e2e']).not.toContain('instrumentation.mjs');
    }
  },
);
