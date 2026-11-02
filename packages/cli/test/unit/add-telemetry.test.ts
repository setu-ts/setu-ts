/**
 * `setu add telemetry` installs what a trace needs (M131a X88-10): the OTLP
 * exporter on every socket runtime and, on Node, the loader hook the generated
 * preload registers plus the instrumentation for the project's Redis client,
 * with the option that enables it named in the guidance.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import { runCli } from '../../src/cli.ts';
import { CLIENT_RANGES } from '../../src/templates/client-dependencies.ts';

function harness() {
  const fs = createFakeFs();
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    fs,
    logs,
    errors,
    run: (args: readonly string[]) =>
      runCli(args, {
        fs,
        cwd: '/work',
        now: () => 0,
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
      }),
  };
}

function dependencies(h: ReturnType<typeof harness>): Record<string, string> {
  return (
    JSON.parse(h.fs.read('/work/svc/package.json')) as {
      dependencies: Record<string, string>;
    }
  ).dependencies;
}

const EXPORTER = '@opentelemetry/exporter-trace-otlp-http';
const HOOK = '@opentelemetry/instrumentation';
const IOREDIS = '@opentelemetry/instrumentation-ioredis';
const REDIS = '@opentelemetry/instrumentation-redis';

/** Project → the packages `add telemetry` must record, and the option it names. */
const TABLE: ReadonlyArray<{
  readonly label: string;
  readonly scaffold: readonly string[];
  readonly present: readonly string[];
  readonly absent: readonly string[];
  readonly option: string | undefined;
}> = [
  {
    label: 'a Node project with no Redis',
    scaffold: ['--template', 'rest', '--runtime', 'node'],
    present: [EXPORTER, HOOK],
    absent: [IOREDIS, REDIS],
    option: undefined,
  },
  {
    label: 'a Node project on ioredis',
    scaffold: ['--template', 'microservice', '--runtime', 'node', '--broker', 'redis'],
    present: [EXPORTER, HOOK, IOREDIS],
    absent: [REDIS],
    option: 'instrumentations: { ioredis: true }',
  },
  {
    label: 'a Node project on node-redis',
    scaffold: [
      '--template',
      'microservice',
      '--runtime',
      'node',
      '--broker',
      'redis',
      '--redis-client',
      'node-redis',
    ],
    present: [EXPORTER, HOOK, REDIS],
    absent: [IOREDIS],
    option: 'instrumentations: { redis: true }',
  },
  {
    label: 'a Bun project on ioredis',
    scaffold: ['--template', 'microservice', '--runtime', 'bun', '--broker', 'redis'],
    present: [EXPORTER],
    absent: [HOOK, IOREDIS, REDIS],
    option: undefined,
  },
];

describe('setu add telemetry (M131a X88-10)', () => {
  it.each(TABLE)('$label', async ({ scaffold, present, absent, option }) => {
    const h = harness();
    expect(await h.run(['new', 'svc', ...scaffold])).toBe(0);
    expect(await h.run(['add', 'telemetry', '--dir', '/work/svc']), h.errors.join('\n')).toBe(0);
    const deps = dependencies(h);
    for (const name of present) expect(deps[name], name).toBe(CLIENT_RANGES[name]);
    for (const name of absent) expect(deps[name], name).toBeUndefined();
    const guidance = h.logs.join('\n');
    if (option === undefined) {
      expect(guidance).not.toContain('instrumentations:');
    } else {
      expect(guidance).toContain(option);
      expect(guidance).toContain('./instrumentation.mjs');
    }
  });

  it('records the exporter in a Deno import map, with no Node hook', async () => {
    const h = harness();
    expect(await h.run(['new', 'svc', '--template', 'rest', '--runtime', 'deno'])).toBe(0);
    expect(await h.run(['add', 'telemetry', '--dir', '/work/svc'])).toBe(0);
    const imports = h.fs.read('/work/svc/deno.json');
    expect(imports).toContain(`"${EXPORTER}"`);
    expect(imports).not.toContain(`"${HOOK}"`);
  });
});
