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
  it.each([
    'const note = "import { CUSTOM_METRICS } from \'./other.ts\'";',
    'const note = "import { CUSTOM_METRICS } from \'./src/metrics/index.ts\'";',
    "import './side.ts'\nconst note = \"CUSTOM_METRICS from './other.ts'\"",
  ])('reads only real import declarations when adding a seam: %s', (prefix) => {
    const inserted = withStarterOption(
      `${prefix}\n${config}`,
      'metrics',
      '{ customMetrics: [...CUSTOM_METRICS] }',
      [{ symbols: ['CUSTOM_METRICS'], from: './src/metrics/index.ts' }],
    );
    expect(inserted).toBeDefined();
    expect(
      inserted!.match(/^import \{ CUSTOM_METRICS \} from '\.\/src\/metrics\/index\.ts';$/gm),
    ).toHaveLength(1);
    expect(inserted).toContain('metrics: { customMetrics: [...CUSTOM_METRICS] }');
  });
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
  it('inserts a dotted arm as a nested literal and never merges an existing parent', () => {
    const inserted = withStarterOption(config, 'realtime.sse', '{}')!;
    expect(inserted).toContain('return {\n        realtime: { sse: {} },');
    expect(withStarterOption(inserted, 'realtime.websocket', '{}')).toBeUndefined();
    for (const parent of ['realtime: undefined', "'realtime': {}", 'realtime', '[key]: value']) {
      const source = config.replace('return {', `return { ${parent},`);
      expect(withStarterOption(source, 'realtime.sse', '{}')).toBeUndefined();
    }
  });
  it('adds seam imports and the arm atomically, reusing a complete import', () => {
    const imports = [{ symbols: ['CUSTOM_METRICS'], from: './src/metrics/index.ts' }];
    const inserted = withStarterOption(
      config,
      'metrics',
      '{ customMetrics: [...CUSTOM_METRICS] }',
      imports,
    )!;
    expect(inserted).toContain("import { CUSTOM_METRICS } from './src/metrics/index.ts';");
    expect(inserted).toContain('metrics: { customMetrics: [...CUSTOM_METRICS] }');
    const existing = `import { CUSTOM_METRICS } from './src/metrics/index.ts';\n${config}`;
    expect(
      withStarterOption(existing, 'metrics', '{}', imports)!.match(/import \{ CUSTOM_METRICS \}/g),
    ).toHaveLength(1);
    expect(withStarterOption(inserted, 'metrics', '{}', imports)).toBeUndefined();
  });
  it('places a missing import after an import declared below the callback', () => {
    const source = `${config}\nimport { OTHER } from './other.ts';\n`;
    const inserted = withStarterOption(source, 'metrics', '{}', [
      { symbols: ['CUSTOM_METRICS'], from: './src/metrics/index.ts' },
    ])!;
    expect(inserted).toContain(
      "import { OTHER } from './other.ts';\nimport { CUSTOM_METRICS } from './src/metrics/index.ts';",
    );
  });
  it.each([
    'const CUSTOM_METRICS = [];',
    'let CUSTOM_METRICS = [];',
    'var CUSTOM_METRICS = [];',
    'function CUSTOM_METRICS() {}',
    'class CUSTOM_METRICS {}',
    'const { metrics: CUSTOM_METRICS } = config;',
    'const [CUSTOM_METRICS] = [];',
    'const other = 1, CUSTOM_METRICS = [];',
    'var after = 1; if (after) { var CUSTOM_METRICS = []; }',
  ])('refuses a reused import shadowed inside the callback: %s', (declaration) => {
    const source = `import { CUSTOM_METRICS } from './src/metrics/index.ts';\n${config.replace('return {', `${declaration}\n      return {`)}`;
    expect(
      withStarterOption(source, 'metrics', '{ customMetrics: [...CUSTOM_METRICS] }', [
        { symbols: ['CUSTOM_METRICS'], from: './src/metrics/index.ts' },
      ]),
    ).toBeUndefined();
  });
  it('reuses an unshadowed import referenced before the returned options', () => {
    const source = `import { CUSTOM_METRICS } from './src/metrics/index.ts';\n${config.replace('return {', 'const count = CUSTOM_METRICS.length;\n      return {')}`;
    expect(
      withStarterOption(source, 'metrics', '{ customMetrics: [...CUSTOM_METRICS] }', [
        { symbols: ['CUSTOM_METRICS'], from: './src/metrics/index.ts' },
      ]),
    ).toContain('metrics: { customMetrics: [...CUSTOM_METRICS] }');
  });
  it.each([
    ' /* note\ncontinued */',
    ' /* first\ncontinued */ /* second\ncontinued */',
    ' // note',
    ' // note /* this is a line comment',
    '',
  ])('keeps an inserted import outside trailing comments %j', (comment) => {
    const statement = `import { OTHER } from './other.ts';${comment}`;
    const source = `${config}\n${statement}\n`;
    const inserted = withStarterOption(source, 'metrics', '{}', [
      { symbols: ['CUSTOM_METRICS'], from: './src/metrics/index.ts' },
    ])!;
    expect(inserted).toContain(
      `${statement}\nimport { CUSTOM_METRICS } from './src/metrics/index.ts';\n`,
    );
  });
  it('does not treat a block-comment marker in a trailing string as a comment', () => {
    const statement = "import { OTHER } from './other.ts'; const note = '/*';";
    const inserted = withStarterOption(`${config}\n${statement}\n`, 'metrics', '{}', [
      { symbols: ['CUSTOM_METRICS'], from: './src/metrics/index.ts' },
    ])!;
    expect(inserted).toContain(
      `${statement}\nimport { CUSTOM_METRICS } from './src/metrics/index.ts';\n`,
    );
  });
  it.each([
    "import { CUSTOM_METRICS } from './other.ts';",
    "import { VALUE as CUSTOM_METRICS } from './other.ts';",
    "import { CUSTOM_METRICS } from './src/metrics/index.ts';\nimport { VALUE as CUSTOM_METRICS } from './other.ts';",
    'const CUSTOM_METRICS = [];',
    "import { OTHER } from './src/metrics/index.ts';",
    "import * as metrics from './src/metrics/index.ts';",
    'const note = `${CUSTOM_METRICS}`;',
    'const note = `${(() => { const CUSTOM_METRICS = []; return CUSTOM_METRICS; })()}`;',
  ])('refuses uncertain or conflicting import bindings: %s', (prefix) => {
    expect(
      withStarterOption(`${prefix}\n${config}`, 'metrics', '{}', [
        { symbols: ['CUSTOM_METRICS'], from: './src/metrics/index.ts' },
      ]),
    ).toBeUndefined();
  });
  it('retains the existing text-mention refusal for edits without seam imports', () => {
    const source = config.replace('return {', "return { note: 'messaging',");
    expect(withStarterOption(source, 'messaging', '{}')).toBeUndefined();
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
    [
      'template substitution in callback',
      config.replace('return {', 'const note = `${config}`; return {'),
    ],
    [
      'nested return',
      config.replace('return {', 'if (config.get("OTHER")) { return {}; } return {'),
    ],
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
  // M138 §3.4: a workspace member's starter arm reads its transport module with
  // one keyless spread, and `setu add queue` must still merge its seam into it.
  it('appends after a single transport-module spread in the arm', () => {
    const source = config.replace(
      'return {',
      'return {\n        queue: { ...queueOptions(config) },',
    );
    expect(withStarterArmEntry(source, 'queue', 'processors', '[...QUEUE_PROCESSORS]')).toBe(
      config.replace(
        'return {',
        'return {\n        queue: {\n          ...queueOptions(config),\n          processors: [...QUEUE_PROCESSORS],\n        },',
      ),
    );
  });
  for (const arm of [
    '{ ...queueOptions(config), ...other(config) }',
    '{ ...queueOptions(config, extra) }',
    '{ ...queueOptions() }',
    '{ ...queueOptions(config).value }',
  ]) {
    it(`still fails closed for ${arm}`, () => {
      const source = config.replace('return {', `return {\n        queue: ${arm},`);
      expect(
        withStarterArmEntry(source, 'queue', 'processors', '[...QUEUE_PROCESSORS]'),
      ).toBeUndefined();
    });
  }
  it('does not accept a transport-module spread at the top of the returned object', () => {
    const source = config.replace('return {', 'return { ...queueOptions(config),');
    expect(withStarterArmEntry(source, 'events', 'handlers', 'EVENT_HANDLERS')).toBeUndefined();
  });
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
