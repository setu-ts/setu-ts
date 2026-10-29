import { describe, expect, it } from 'vitest';
import {
  starterOptionValue,
  withStarterOption,
  withStarterArmEntry,
  starterLiteralEntries,
} from '../../../src/commands/starter-options.ts';
import { FULL_STACK_TEMPLATE } from '../../../src/templates/full-stack.ts';
import { projectFiles, resolveHost } from '../../../src/templates/project-files.ts';

const config = projectFiles('portal', 'deno', resolveHost(FULL_STACK_TEMPLATE, 'deno')).find(
  (file) => file.path === 'setu.config.ts',
)!.contents;

describe('withStarterOption', () => {
  for (const key of ['messaging', 'queue'] as const) {
    it(`inserts absent ${key} first in the generated return object, only once`, () => {
      const literal = key === 'messaging' ? "{ broker: 'memory' }" : "{ adapter: 'memory' }";
      const inserted = withStarterOption(config, key, literal)!;
      expect(inserted).toContain(`return {\n        ${key}: ${literal},`);
      expect(inserted.replace(`\n        ${key}: ${literal},`, '')).toBe(config);
      expect(withStarterOption(inserted, key, literal)).toBeUndefined();
    });
  }
  it('shifts a multi-line literal to the property depth of the returned object', () => {
    const literal = "{\n          broker: 'nats',\n          url: 'nats://x',\n        }";
    const inserted = withStarterOption(config, 'messaging', literal)!;
    expect(inserted).toContain(
      "return {\n        messaging: {\n          broker: 'nats',\n          url: 'nats://x',\n        },\n        reactRouter",
    );
  });
  it('follows the returned object a hand edit indented differently', () => {
    const shifted = config.replace(
      '      return {\n        reactRouter',
      '    return {\n        reactRouter',
    );
    const inserted = withStarterOption(
      shifted,
      'queue',
      "{\n          adapter: 'memory',\n        }",
    )!;
    expect(inserted).toContain(
      "    return {\n      queue: {\n        adapter: 'memory',\n      },",
    );
  });
  it('is not moved by a brace or the key inside a comment', () => {
    const commented = config.replace(
      'return {\n        reactRouter',
      '// } messaging {\n      return {\n        reactRouter',
    );
    expect(withStarterOption(commented, 'messaging', '{}')).toContain(
      'return {\n        messaging: {},\n        reactRouter',
    );
  });
  const cases = [
    ['unbalanced callback', config.slice(0, config.indexOf('return {'))],
    ['no callback', config.replace('(config): FullStackStarterOptions =>', '(config) =>')],
    [
      'two callbacks',
      config.replace(
        'return {\n        reactRouter',
        'const other = (config): FullStackStarterOptions => {};\n      return {\n        reactRouter',
      ),
    ],
    [
      'key exists',
      config.replace(
        'return {\n        reactRouter',
        'return {\n        messaging: {},\n        reactRouter',
      ),
    ],
    [
      'quoted key exists',
      config.replace(
        'return {\n        reactRouter',
        "return {\n        'messaging': {},\n        reactRouter",
      ),
    ],
    ['unclassifiable', config + '\nconst extra = /regex/;'],
    ['no factory', 'export const createApp = () => ({});'],
    ['another starter', config.replaceAll('full-stack-starter', 'microservice-starter')],
    ['no factory call', config.replace('await createFullStackAppFromConfig(', 'await makeApp(')],
    [
      'no return',
      config.replace('return {\n        reactRouter', 'const options = {\n        reactRouter'),
    ],
    [
      'non-object return',
      config.replace(
        'return {\n        reactRouter',
        'return options;\n      const unused = {\n        reactRouter',
      ),
    ],
    [
      'two returns',
      config.replace(
        'return {\n        reactRouter',
        'return {};\n      return {\n        reactRouter',
      ),
    ],
    [
      'spread may contain key',
      config.replace(
        'return {\n        reactRouter',
        'return {\n        ...options,\n        reactRouter',
      ),
    ],
  ];
  for (const [name, source] of cases) {
    it(`refuses ${name}`, () =>
      expect(withStarterOption(source!, 'messaging', '{}')).toBeUndefined());
  }
});

describe('starterOptionValue', () => {
  it('reads nothing when the option is absent, and the value once inserted', () => {
    expect(starterOptionValue(config, 'messaging')).toBeUndefined();
    const literal = "{\n          broker: 'nats',\n        }";
    const inserted = withStarterOption(config, 'messaging', literal)!;
    expect(starterOptionValue(inserted, 'messaging')).toBe(literal.trim());
    expect(starterOptionValue(inserted, 'queue')).toBeUndefined();
  });
  it('reads a quoted key and ignores a nested property of the same name', () => {
    const quoted = config.replace(
      'return {\n        reactRouter',
      "return {\n        'queue': { adapter: 'redis' },\n        reactRouter",
    );
    expect(starterOptionValue(quoted, 'queue')).toBe("{ adapter: 'redis' }");
    const nested = config.replace(
      'return {\n        reactRouter',
      "return {\n        session2: { queue: { adapter: 'x' } },\n        reactRouter",
    );
    expect(starterOptionValue(nested, 'queue')).toBeUndefined();
  });
  it('reads nothing from an unclassified shape', () => {
    expect(starterOptionValue('export const createApp = () => ({});', 'queue')).toBeUndefined();
  });
});

describe('withStarterArmEntry', () => {
  it('inserts an absent arm and appends an absent property on its own line', () => {
    const first = withStarterArmEntry(config, 'events', 'handlers', 'EVENT_HANDLERS')!;
    expect(first).toContain('events: { handlers: EVENT_HANDLERS }');
    const second = withStarterArmEntry(first, 'events', 'async', 'true')!;
    expect(second).toContain(
      'events: {\n          handlers: EVENT_HANDLERS,\n          async: true,\n        }',
    );
    expect(starterOptionValue(first, 'events')).toBe('{ handlers: EVENT_HANDLERS }');
    expect(withStarterArmEntry(first, 'events', 'handlers', 'OTHER')).toBeUndefined();
  });
  for (const [label, before, after] of [
    [
      'single-line with nested commas',
      "        queue: { custom: { labels: ['x', 'y'] }, enabled: true },",
      "        queue: {\n          custom: { labels: ['x', 'y'] },\n          enabled: true,\n          processors: [...QUEUE_PROCESSORS],\n        },",
    ],
    [
      'multi-line with trailing comma',
      '        queue: {\n          enabled: true,\n        },',
      '        queue: {\n          enabled: true,\n          processors: [...QUEUE_PROCESSORS],\n        },',
    ],
    [
      'multi-line without trailing comma',
      '        queue: {\n          enabled: true\n        },',
      '        queue: {\n          enabled: true,\n          processors: [...QUEUE_PROCESSORS],\n        },',
    ],
    [
      'multi-line ending in a comment',
      '        queue: {\n          enabled: true // preserve\n        },',
      '        queue: {\n          enabled: true, // preserve\n          processors: [...QUEUE_PROCESSORS],\n        },',
    ],
    [
      'empty arm',
      '        queue: {},',
      '        queue: {\n          processors: [...QUEUE_PROCESSORS],\n        },',
    ],
  ]) {
    it(`appends a property with exact output: ${label}`, () => {
      const source = config.replace('      return {\n', `      return {\n${before}\n`);
      const expected = config.replace('      return {\n', `      return {\n${after}\n`);
      expect(withStarterArmEntry(source, 'queue', 'processors', '[...QUEUE_PROCESSORS]')).toBe(
        expected,
      );
    });
  }
  it('accepts a quoted key and preserves nested properties, strings and comments', () => {
    const source = config.replace(
      'return {',
      "return {\n        'queue': { other: { processors: [] }, text: '}', /* } */ },",
    );
    expect(withStarterArmEntry(source, 'queue', 'processors', '[...QUEUE_PROCESSORS]')).toContain(
      'processors: [...QUEUE_PROCESSORS]',
    );
  });
  for (const arm of [
    'queueOptions',
    'makeQueue()',
    '{ ...options }',
    '{ processors: [] }',
    "{ 'processors': [] }",
    '{ [key]: [] }',
    '{ get value() {} }',
    '{ value: 1, value: 2 }',
    '{} as Options',
  ]) {
    it(`fails closed for ${arm}`, () => {
      const source = config.replace('return {', `return {\n        queue: ${arm},`);
      expect(
        withStarterArmEntry(source, 'queue', 'processors', '[...QUEUE_PROCESSORS]'),
      ).toBeUndefined();
    });
  }
  it('refuses spreads, uncertain callbacks, duplicate arms and nested mentions of an absent arm', () => {
    for (const source of [
      'broken',
      config.replace('return {', 'return { ...other,'),
      config.replace('return {', 'return { queue: {}, queue: {},'),
      config.replace('return {', 'return { note: { events: true },'),
    ]) {
      expect(withStarterArmEntry(source, 'events', 'handlers', 'EVENT_HANDLERS')).toBeUndefined();
    }
  });
  it('uses the same walker to split transport literals', () => {
    expect(
      starterLiteralEntries(
        "{ adapter: 'redis', connection: { url: 'x,y' }, processors: [...VALUES], }",
      ),
    ).toEqual([
      ['adapter', "'redis'"],
      ['connection', "{ url: 'x,y' }"],
      ['processors', '[...VALUES]'],
    ]);
    for (const literal of ['x', '{', '{} trailing', '{ ...options }', '{ x: 1, x: 2 }', '/regex/'])
      expect(starterLiteralEntries(literal)).toBeUndefined();
  });
});
