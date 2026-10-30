import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { renderPluginCall } from '../../src/utils/render-call.ts';

/** The two-line read a Deno connection renders as. */
const DENO_READ = "Deno.env.get('REDIS_URL') ??\n          'redis://127.0.0.1:6379'";

/** Each shape the CLI writes, at the indent of the generated `plugins: [` array unless named. */
const LAYOUTS: readonly (readonly [string, string, string, string, number?])[] = [
  [
    'a short call stays on one line',
    'CachePlugin',
    "{ store: 'memory' }",
    "CachePlugin({ store: 'memory' })",
  ],
  ['no options', 'EventsPlugin', '', 'EventsPlugin()'],
  [
    'an overflowing object breaks one property per line, the read joined',
    'MessagingPlugin',
    `{ broker: 'redis-streams', url: ${DENO_READ} }`,
    "MessagingPlugin({\n        broker: 'redis-streams',\n        url: Deno.env.get('REDIS_URL') ?? 'redis://127.0.0.1:6379',\n      })",
  ],
  [
    'merged seam and transport options lose their stray spaces',
    'QueuePlugin',
    `{  processors: [...QUEUE_PROCESSORS] ,  adapter: 'redis', url: ${DENO_READ}  }`,
    "QueuePlugin({\n        processors: [...QUEUE_PROCESSORS],\n        adapter: 'redis',\n        url: Deno.env.get('REDIS_URL') ?? 'redis://127.0.0.1:6379',\n      })",
  ],
  [
    'a nested object breaks only when it overflows',
    'SchedulerPlugin',
    `{ distributedLock: { enabled: true, storage: 'redis', url: ${DENO_READ} } }`,
    "SchedulerPlugin({\n        distributedLock: {\n          enabled: true,\n          storage: 'redis',\n          url: Deno.env.get('REDIS_URL') ?? 'redis://127.0.0.1:6379',\n        },\n      })",
  ],
  [
    'a pre-broken call argument is joined when it fits',
    'CachePlugin',
    "{ store: 'redis', options: { client: nodeRedisClient(\n          Deno.env.get('REDIS_URL') ??\n            'redis://127.0.0.1:6379',\n        ) } }",
    "CachePlugin({\n        store: 'redis',\n        options: { client: nodeRedisClient(Deno.env.get('REDIS_URL') ?? 'redis://127.0.0.1:6379') },\n      })",
  ],
  [
    'an overflowing ?? chain continues one level in',
    'MessagingPlugin',
    "{ url: Deno.env.get('A_VERY_LONG_ENVIRONMENT_VARIABLE_NAME_FOR_THE_BROKER') ?? 'redis://a-very-long-host-name.internal.example:6379' }",
    "MessagingPlugin({\n        url: Deno.env.get('A_VERY_LONG_ENVIRONMENT_VARIABLE_NAME_FOR_THE_BROKER') ??\n          'redis://a-very-long-host-name.internal.example:6379',\n      })",
  ],
  [
    'an overflowing call moves its argument in, then breaks the chain',
    'MessagingPlugin',
    "{ client: someFactoryFunctionName(Deno.env.get('A_VERY_LONG_ENVIRONMENT_VARIABLE_NAME') ?? 'redis://a-long-host.example:6379') }",
    "MessagingPlugin({\n        client: someFactoryFunctionName(\n          Deno.env.get('A_VERY_LONG_ENVIRONMENT_VARIABLE_NAME') ??\n            'redis://a-long-host.example:6379',\n        ),\n      })",
  ],
  [
    'an overflowing array breaks one item per line',
    'MessagingPlugin',
    "{ streamSubjects: ['orders.created.v1', 'orders.cancelled.v1', 'payments.settled.v1', 'payments.refunded.v1'] }",
    "MessagingPlugin({\n        streamSubjects: [\n          'orders.created.v1',\n          'orders.cancelled.v1',\n          'payments.settled.v1',\n          'payments.refunded.v1',\n        ],\n      })",
  ],
  [
    'a call with several arguments puts each on its own line',
    'Twin',
    "{ a: makeThing('aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccc') }",
    "Twin({\n        a: makeThing(\n          'aaaaaaaaaaaaaaaaaaaaaaaaaaaa',\n          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',\n          'cccccccccccccccccccc',\n        ),\n      })",
  ],
  [
    'an || chain breaks before each operand',
    'P',
    "{ url: process.env.SOME_LONG_VARIABLE_NAME_HERE || process.env.ANOTHER_LONG_VARIABLE || 'fallback-value' }",
    "P({\n        url: process.env.SOME_LONG_VARIABLE_NAME_HERE ||\n          process.env.ANOTHER_LONG_VARIABLE ||\n          'fallback-value',\n      })",
  ],
  [
    'quoted keys, escapes and template literals pass through',
    'P',
    "{ 'x-key': 'a\\\\b', y: `t${1}`, z: 'a,b:c' }",
    "P({ 'x-key': 'a\\\\b', y: `t${1}`, z: 'a,b:c' })",
  ],
  ['shorthand and spread members', 'P', '{ handlers, ...rest }', 'P({ handlers, ...rest })'],
  [
    'an atom keeps quoted whitespace and collapses the rest',
    'P',
    "{ a: left   +\n   'x  y' }",
    "P({ a: left + 'x  y' })",
  ],
  [
    'a deeper array indents from its own line',
    'MessagingPlugin',
    `{ broker: 'redis-streams', url: ${DENO_READ} }`,
    "MessagingPlugin({\n            broker: 'redis-streams',\n            url: Deno.env.get('REDIS_URL') ?? 'redis://127.0.0.1:6379',\n          })",
    10,
  ],
];

/** Finds `deno` once; the formatter rows run only where it is installed. */
const DENO = spawnSync('deno', ['--version']).status === 0;

/**
 * Formats a call placed at `indent` inside nested arrays with the generated
 * project's `fmt` settings, and reports whether `deno fmt` left it unchanged.
 */
function denoKeeps(call: string, indent: number): boolean {
  let body = `${' '.repeat(indent)}${call},`;
  for (let depth = indent / 2 - 1; depth >= 1; depth -= 1) {
    body = `${' '.repeat(depth * 2)}[\n${body}\n${' '.repeat(depth * 2)}],`;
  }
  const source = `export const x = [\n${body}\n];\n`;
  const result = spawnSync(
    'deno',
    ['fmt', '--line-width=100', '--indent-width=2', '--single-quote', '--ext=ts', '-'],
    { input: source },
  );
  return result.status === 0 && result.stdout.toString() === source;
}

describe('renderPluginCall', () => {
  for (const [name, factory, args, expected, indent = 6] of LAYOUTS) {
    it(name, () => {
      expect(renderPluginCall(factory, args, indent)).toBe(expected);
    });
  }

  it.skipIf(!DENO)('lays out every row as deno fmt keeps it', () => {
    const changed = LAYOUTS.filter(
      ([, factory, args, , indent = 6]) =>
        !denoKeeps(renderPluginCall(factory, args, indent), indent),
    ).map(([name]) => name);
    expect(changed).toEqual([]);
  });

  it.each([
    ['an empty member value', '{ a: }'],
    ['a computed key', '{ [key]: 1 }'],
    ['an unclosed quote', "{ a: 'open }"],
    ['a mismatched bracket', '{ a: f(1 }'],
    ['a stray closing bracket', '{ a: 1 }) ({'],
  ])('keeps %s exactly as written', (_name, args) => {
    expect(renderPluginCall('P', args, 6)).toBe(`P(${args})`);
  });

  it('leaves what cannot break on one line, however far in it starts', () => {
    expect(renderPluginCall('P', '{}', 98)).toBe('P({})');
    expect(renderPluginCall('P', '[]', 98)).toBe('P([])');
    expect(renderPluginCall('P', '{ a: f() }', 96)).toBe(
      'P({\n' + ' '.repeat(98) + 'a: f(),\n' + ' '.repeat(96) + '})',
    );
    expect(renderPluginCall('P', `{ a: ${'x'.repeat(120)} }`, 6)).toBe(
      `P({\n        a: ${'x'.repeat(120)},\n      })`,
    );
    expect(renderPluginCall('P', `{ ...${'x'.repeat(120)} }`, 6)).toBe(
      `P({\n        ...${'x'.repeat(120)},\n      })`,
    );
  });

  it('treats an expression that merely ends in brackets as one atom', () => {
    expect(renderPluginCall('P', '{ a: f(1)(2), b: [1] + [2], c: g(x) + h(y) }', 6)).toBe(
      'P({ a: f(1)(2), b: [1] + [2], c: g(x) + h(y) })',
    );
  });
});
