import { expect, it } from 'vitest';
import * as ts from 'typescript';
import { runNewCommand } from '../../../src/commands/new.ts';
import { runAddCommand } from '../../../src/commands/add.ts';
import { parseArgs } from '../../../src/args.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';

const LAST_IMPORT = "import { GENERATED_PLUGINS } from './src/plugins/index.ts';";
const CONFIG_PATH = '/app/shop/setu.config.ts';
const REDIS_ARM = `        queue: {
          processors: [...QUEUE_PROCESSORS],
          adapter: 'redis',
          url: config.get<string>('REDIS_URL', { default: 'redis://127.0.0.1:6379' }),
        },`;

async function scaffold() {
  const fs = createFakeFs();
  const deps = { fs, cwd: '/app', log: () => {}, error: () => {} };
  expect(
    await runNewCommand(parseArgs(['shop', '--template', 'full-stack', '--runtime', 'node']), deps),
  ).toBe(0);
  const base = fs.read(CONFIG_PATH);
  return {
    fs,
    base,
    add: (args: readonly string[]) =>
      runAddCommand(parseArgs([...args, '--dir', '/app/shop']), deps),
  };
}

function expected(base: string, imports: readonly string[], arms: readonly string[]): string {
  expect(base).toContain(LAST_IMPORT);
  expect(base).toContain('      return {\n');
  return base
    .replace(LAST_IMPORT, [LAST_IMPORT, ...imports].join('\n'))
    .replace('      return {\n', `      return {\n${arms.join('\n')}\n`);
}

function assertConfig(actual: string, wanted: string): void {
  expect(actual).toBe(wanted);
  const compiled = ts.transpileModule(actual, {
    fileName: 'setu.config.ts',
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  expect(compiled.diagnostics).toEqual([]);
}

for (const [name, declaration, arm] of [
  [
    'events',
    "import { EVENT_HANDLERS } from './src/events/index.ts';",
    '        events: { handlers: EVENT_HANDLERS },',
  ],
  [
    'cqrs',
    "import { COMMAND_HANDLERS, QUERY_HANDLERS } from './src/cqrs/index.ts';",
    '        cqrs: { commandHandlers: COMMAND_HANDLERS, queryHandlers: QUERY_HANDLERS },',
  ],
  [
    'queue',
    "import { QUEUE_PROCESSORS } from './src/jobs/index.ts';",
    '        queue: { processors: [...QUEUE_PROCESSORS] },',
  ],
] as const) {
  it(`pins the entire generated config and syntax after add ${name}`, async () => {
    const h = await scaffold();
    expect(await h.add([name])).toBe(0);
    assertConfig(h.fs.read(CONFIG_PATH), expected(h.base, [declaration], [arm]));
  });
}

for (const [label, order] of [
  ['queue then redis', [[], ['--queue', 'redis']]],
  ['redis then queue', [['--queue', 'redis'], []]],
] as const) {
  it(`pins the entire generated config and syntax for ${label}`, async () => {
    const h = await scaffold();
    for (const flags of order) expect(await h.add(['queue', ...flags])).toBe(0);
    assertConfig(
      h.fs.read(CONFIG_PATH),
      expected(h.base, ["import { QUEUE_PROCESSORS } from './src/jobs/index.ts';"], [REDIS_ARM]),
    );
  });
}

for (const semicolon of [';', '']) {
  it(`inserts after a multi-line last import with ${semicolon === '' ? 'no' : 'a'} semicolon`, async () => {
    const h = await scaffold();
    const multiline = `import {\n  GENERATED_PLUGINS,\n  GENERATED_PLUGINS as other,\n} from './src/plugins/index.ts'${semicolon}`;
    await h.fs.writeFile(
      CONFIG_PATH,
      new TextEncoder().encode(h.base.replace(LAST_IMPORT, multiline)),
    );
    expect(await h.add(['events'])).toBe(0);
    const formattedBase = h.base.replace(
      LAST_IMPORT,
      "import { GENERATED_PLUGINS, GENERATED_PLUGINS as other } from './src/plugins/index.ts';",
    );
    // Expected output is authored independently of the editor and of its formatter.
    const wanted = formattedBase
      .replace(
        "from './src/plugins/index.ts';",
        "from './src/plugins/index.ts';\nimport { EVENT_HANDLERS } from './src/events/index.ts';",
      )
      .replace(
        '      return {\n',
        '      return {\n        events: { handlers: EVENT_HANDLERS },\n',
      );
    assertConfig(h.fs.read(CONFIG_PATH), wanted);
  });
}

it('pins cumulative imports and arms after events, cqrs, queue and redis', async () => {
  const h = await scaffold();
  for (const args of [['events'], ['cqrs'], ['queue'], ['queue', '--queue', 'redis']])
    expect(await h.add(args)).toBe(0);
  assertConfig(
    h.fs.read(CONFIG_PATH),
    expected(
      h.base,
      [
        "import { EVENT_HANDLERS } from './src/events/index.ts';",
        "import { COMMAND_HANDLERS, QUERY_HANDLERS } from './src/cqrs/index.ts';",
        "import { QUEUE_PROCESSORS } from './src/jobs/index.ts';",
      ],
      [
        REDIS_ARM,
        '        cqrs: { commandHandlers: COMMAND_HANDLERS, queryHandlers: QUERY_HANDLERS },',
        '        events: { handlers: EVENT_HANDLERS },',
      ],
    ),
  );
});

it('inserts after a last side-effect import and preserves its end-of-line comment', async () => {
  const h = await scaffold();
  const tail = `import './setup.js'; // application setup`;
  const source = h.base.replace(LAST_IMPORT, `${LAST_IMPORT}\n${tail}`);
  await h.fs.writeFile(CONFIG_PATH, new TextEncoder().encode(source));
  expect(await h.add(['events'])).toBe(0);
  const wanted = source
    .replace(tail, `${tail}\nimport { EVENT_HANDLERS } from './src/events/index.ts';`)
    .replace('      return {\n', '      return {\n        events: { handlers: EVENT_HANDLERS },\n');
  assertConfig(h.fs.read(CONFIG_PATH), wanted);
});
