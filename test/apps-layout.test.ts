/**
 * Keeps the example applications in the layout the CLI scaffolds.
 *
 * The expected layout is not written down here: it is read from projects the
 * real CLI generates from this tree's source. So when the generator changes
 * its layout, this test fails and names what moved, and the examples are
 * brought along instead of drifting.
 */
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../scripts/lib/run.ts';

const ROOT = resolve(import.meta.dirname, '..');
const APPS = join(ROOT, 'apps');
const CLI = join(ROOT, 'packages/cli');
const SOURCE_REGISTER = join(ROOT, 'scripts/lib/source-register.ts');

/** Every file of one project, keyed by its path relative to the project root. */
type Snapshot = ReadonlyMap<string, string>;

/** What a generated project looks like, read from the CLI's own output. */
interface Layout {
  /** The composition file, relative to the project root. */
  readonly configFile: string;
  /** The factory the composition file exports. */
  readonly factory: string;
  /** The signals the generated entry handles. */
  readonly signals: readonly string[];
  /** The module the generated tests import their runner from. */
  readonly testRunner: string;
  /** The symbol the module index exports, per generator style. */
  readonly moduleIndexSymbol: { readonly functional: string; readonly classBased: string };
  /** How the module index imports one feature, with `<feature>` as a placeholder. */
  readonly featureImport: { readonly functional: string; readonly classBased: string };
}

const GENERATED_FEATURE = 'widget';

// ---------------------------------------------------------------- scaffolding

async function cli(args: readonly string[]): Promise<void> {
  const { code, stderr } = await run(
    process.execPath,
    ['--import', 'tsx', '--import', SOURCE_REGISTER, 'src/bin.ts', ...args],
    { cwd: CLI, capture: 'file', timeoutMs: 120_000 },
  );
  if (code !== 0) throw new Error(`setu ${args.join(' ')} exited ${code}: ${stderr}`);
}

/** Scaffolds a `rest` project in the given style and generates one feature module into it. */
async function scaffold(parent: string, style: 'functional' | 'class-based'): Promise<string> {
  await cli(
    ['new', style, '--template', 'rest', '--style', style, '--runtime', 'node'].concat([
      '--dir',
      parent,
      '--yes',
    ]),
  );
  const project = join(parent, style);
  // The first module takes the scaffold's greeting example with it.
  await cli(['generate', 'module', GENERATED_FEATURE, '--dir', project, '--adopt-controllers']);
  return project;
}

async function snapshot(directory: string): Promise<Snapshot> {
  const files = new Map<string, string>();
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'build' || entry.name.startsWith('.')) {
        continue;
      }
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.set(relative(directory, path), await readFile(path, 'utf8'));
    }
  };
  await walk(directory);
  return files;
}

function required(project: Snapshot, path: string): string {
  const content = project.get(path);
  if (content === undefined) throw new Error(`the generated project has no ${path}`);
  return content;
}

function match(source: string, pattern: RegExp, what: string): string {
  const found = pattern.exec(source)?.[1];
  if (found === undefined) throw new Error(`could not read ${what} from the generated project`);
  return found;
}

/** The exported declaration of `symbol`, up to the next blank line. */
function declarationOf(source: string, symbol: string): string {
  const start = source.search(new RegExp(`export (?:function|const) ${symbol}\\b`));
  if (start === -1) throw new Error(`the generated module index does not export ${symbol}`);
  const end = source.indexOf('\n\n', start);
  return source.slice(start, end === -1 ? undefined : end);
}

/** Whether `source` refers to the identifier `name`. */
function mentions(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(source);
}

/** The feature folders under `src/modules/`. */
function featureFolders(app: Snapshot): Set<string> {
  return new Set(
    [...app.keys()]
      .map((path) => /^src\/modules\/([^/]+)\//.exec(path)?.[1])
      .filter((feature): feature is string => feature !== undefined),
  );
}

/** The source with its import statements removed, so an unused import counts as no use. */
function withoutImports(source: string): string {
  return source.replace(/^import[\s\S]*?from '[^']+';$/gm, '');
}

/** Reads the layout facts this gate holds the examples to. */
function readLayout(functional: Snapshot, classBased: Snapshot): Layout {
  const main = required(functional, 'main.ts');
  const configFile = match(main, /from '\.\/([\w.-]+\.ts)'/, "the entry's composition import");
  const factory = match(
    required(functional, configFile),
    /export (?:async )?function (\w+)/,
    'the factory',
  );
  const signals = match(main, /for \(const signal of \[([^\]]+)\]/, 'the handled signals')
    .split(',')
    .map((signal) => signal.trim().replace(/'/g, ''));
  const testRunner = match(
    required(functional, 'test/app.test.ts'),
    /from '(node:test|vitest|bun:test)'/,
    'the test runner',
  );
  const functionalIndex = required(functional, 'src/modules/index.ts');
  const classIndex = required(classBased, 'src/modules/index.ts');
  // The import the index's exported symbol actually uses: a class-based index
  // also imports controllers and services for deprecated compatibility arrays,
  // which say nothing about how a feature is activated.
  const featureImport = (index: string, symbol: string): string => {
    const declaration = declarationOf(index, symbol);
    for (const [, names = '', from = ''] of index.matchAll(/import \{([^}]+)\} from '([^']+)'/g)) {
      const usedByDeclaration = names.split(',').some((name) => mentions(declaration, name.trim()));
      if (usedByDeclaration && from.startsWith(`./${GENERATED_FEATURE}/`)) {
        return from.replaceAll(GENERATED_FEATURE, '<feature>');
      }
    }
    throw new Error(`could not read how the generated ${symbol} imports a feature`);
  };
  const functionalSymbol = match(functionalIndex, /export function (\w+)/, 'the module index');
  const classSymbol = match(classIndex, /export const (\w+)/, 'the class-based module index');
  return {
    configFile,
    factory,
    signals,
    testRunner,
    moduleIndexSymbol: { functional: functionalSymbol, classBased: classSymbol },
    featureImport: {
      functional: featureImport(functionalIndex, functionalSymbol),
      classBased: featureImport(classIndex, classSymbol),
    },
  };
}

// ---------------------------------------------------------------------- rules

/** A layout rule: an empty list means the app follows it. */
type Rule = (app: Snapshot, layout: Layout) => string[];

const RULES = {
  /** The application is composed in the generated composition file, by the generated factory. */
  composition(app, layout) {
    const config = app.get(layout.configFile);
    if (config === undefined) return [`has no ${layout.configFile}`];
    return new RegExp(`export (?:async )?function ${layout.factory}\\b`).test(config)
      ? []
      : [`${layout.configFile} does not export ${layout.factory}()`];
  },

  /** The entry builds the app through the factory and handles the generated shutdown signals. */
  entry(app, layout) {
    const main = app.get('main.ts');
    if (main === undefined) return ['has no main.ts'];
    const problems: string[] = [];
    if (!main.includes(`from './${layout.configFile}'`)) {
      problems.push(`main.ts does not import from ./${layout.configFile}`);
    }
    for (const signal of layout.signals) {
      if (!main.includes(`'${signal}'`)) problems.push(`main.ts does not handle ${signal}`);
    }
    if (!main.includes('onSignal?.('))
      problems.push('main.ts does not register through runtime.onSignal');
    return problems;
  },

  /** The smoke check uses the test runner the generated tests use. */
  smoke(app, layout) {
    const smoke = app.get('smoke.ts');
    if (smoke === undefined) return ['has no smoke.ts'];
    return smoke.includes(`from '${layout.testRunner}'`)
      ? []
      : [`smoke.ts does not use ${layout.testRunner}`];
  },

  /** Routes are declared in controllers: no `src/**\/*.routes.ts` beside them. */
  controllers(app) {
    return [...app.keys()]
      .filter((path) => path.startsWith('src/') && path.endsWith('.routes.ts'))
      .map((path) => `${path} registers routes outside a controller (name it *.controller.ts)`);
  },

  /** Every file in a feature folder is its index or is named after the feature. */
  featureFiles(app) {
    const problems: string[] = [];
    for (const path of app.keys()) {
      const parts = /^src\/modules\/([^/]+)\/([^/]+)$/.exec(path);
      if (parts === null) continue;
      const [, feature, file] = parts as unknown as [string, string, string];
      if (file !== 'index.ts' && !file.startsWith(`${feature}.`)) {
        problems.push(`${path} is not named after its feature (${feature}.*)`);
      }
    }
    return problems;
  },

  /** A module index exports the generated symbol, imports every feature the generated way, and is wired. */
  moduleIndex(app, layout) {
    const features = featureFolders(app);
    const index = app.get('src/modules/index.ts');
    if (index === undefined) {
      return features.size === 0 ? [] : ['has feature folders but no src/modules/index.ts'];
    }
    const style = index.includes(`export const ${layout.moduleIndexSymbol.classBased}`)
      ? 'classBased'
      : 'functional';
    const symbol = layout.moduleIndexSymbol[style];
    const problems: string[] = [];
    if (!new RegExp(`export (?:function|const) ${symbol}\\b`).test(index)) {
      problems.push(`src/modules/index.ts does not export ${symbol}`);
    }
    for (const feature of features) {
      const expected = layout.featureImport[style].replaceAll('<feature>', feature);
      if (!index.includes(`'${expected}'`)) {
        problems.push(`src/modules/index.ts does not import ${expected}`);
      }
    }
    // Used, not merely imported: a function index must be called, an array spread or passed.
    const config = withoutImports(app.get(layout.configFile) ?? '');
    const wired =
      style === 'functional'
        ? new RegExp(`\\b${symbol}\\s*\\(`).test(config)
        : mentions(config, symbol);
    if (!wired) {
      problems.push(`${layout.configFile} does not use ${symbol} from src/modules/index.ts`);
    }
    return problems;
  },
} satisfies Record<string, Rule>;

type RuleName = keyof typeof RULES;

/**
 * Where an example departs from the generated layout, and why.
 *
 * Each entry must still be needed: an exception whose rule now passes fails
 * this test, so the list only shrinks when an example comes into line.
 */
const EXCEPTIONS: Readonly<Record<string, Partial<Record<RuleName, string>>>> = {
  cloudflare: {
    entry: 'A Worker is started by workerd through worker.ts; main.ts only explains how to run it.',
  },
  cqrs: {
    entry: 'main.ts is a run-and-exit demonstration, not a server.',
    moduleIndex: 'Its feature registers CQRS handlers through CqrsPlugin options, not routes.',
  },
  'graphql-demo': {
    moduleIndex:
      'Its feature is a schema and resolvers passed to GraphqlPlugin options, not routes.',
  },
  grpc: {
    moduleIndex: 'Its feature is an RPC service registered through GrpcPlugin options, not routes.',
  },
  microservices: {
    composition:
      'It composes two services, one factory each under src/service-a/ and src/service-b/.',
    entry: 'main.ts is a run-and-exit demonstration of two services, not a server.',
  },
};

// ---------------------------------------------------------------------- tests

describe('example applications follow the generated layout', () => {
  let scratch: string;
  let layout: Layout;
  const apps = new Map<string, Snapshot>();

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'setu-apps-layout-'));
    const [functional, classBased] = await Promise.all([
      scaffold(scratch, 'functional').then(snapshot),
      scaffold(scratch, 'class-based').then(snapshot),
    ]);
    layout = readLayout(functional, classBased);

    for (const entry of await readdir(APPS, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(APPS, entry.name);
      if ((await stat(join(directory, 'package.json')).catch(() => null)) === null) continue;
      apps.set(entry.name, await snapshot(directory));
    }
  }, 300_000);

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('reads a layout from the generated projects', () => {
    // Pinned so a reader sees what the examples are held to. A change here
    // means the generator moved: update the examples, then this expectation.
    expect(layout).toEqual({
      configFile: 'setu.config.ts',
      factory: 'createApp',
      signals: ['SIGTERM', 'SIGINT'],
      testRunner: 'node:test',
      moduleIndexSymbol: { functional: 'registerModules', classBased: 'MODULES' },
      featureImport: {
        functional: './<feature>/index.ts',
        classBased: './<feature>/<feature>.module.ts',
      },
    });
  });

  it('finds every example', () => {
    expect(apps.size).toBeGreaterThanOrEqual(17);
    for (const name of Object.keys(EXCEPTIONS)) expect(apps.has(name), name).toBe(true);
  });

  for (const rule of Object.keys(RULES) as RuleName[]) {
    it(`every example follows the ${rule} rule, or is excepted with a reason`, () => {
      const violations: string[] = [];
      for (const [name, app] of apps) {
        const problems = RULES[rule](app, layout);
        const exception = EXCEPTIONS[name]?.[rule];
        if (exception === undefined) {
          violations.push(...problems.map((problem) => `apps/${name}: ${problem}`));
        } else if (problems.length === 0) {
          violations.push(`apps/${name}: the ${rule} exception is no longer needed; remove it`);
        }
      }
      expect(violations).toEqual([]);
    });
  }
});

describe('each layout rule can fail', () => {
  // Synthetic apps, so a rule that silently accepts everything is caught here
  // rather than discovered when an example drifts past it.
  const layout: Layout = {
    configFile: 'setu.config.ts',
    factory: 'createApp',
    signals: ['SIGTERM', 'SIGINT'],
    testRunner: 'node:test',
    moduleIndexSymbol: { functional: 'registerModules', classBased: 'MODULES' },
    featureImport: {
      functional: './<feature>/index.ts',
      classBased: './<feature>/<feature>.module.ts',
    },
  };
  const app = (files: Record<string, string>): Snapshot => new Map(Object.entries(files));

  it('composition: refuses a differently named factory', () => {
    expect(
      RULES.composition(app({ 'setu.config.ts': 'export function createExampleApp() {}' }), layout),
    ).toHaveLength(1);
  });

  it('entry: refuses an entry with no shutdown handling', () => {
    const main = "import { createApp } from './setu.config.ts';\nawait createApp().start();";
    expect(RULES.entry(app({ 'main.ts': main }), layout)).toHaveLength(3);
  });

  it('smoke: refuses a smoke check with hand-written assertions', () => {
    expect(RULES.smoke(app({ 'smoke.ts': "if (x) throw new Error('no');" }), layout)).toHaveLength(
      1,
    );
  });

  it('controllers: refuses a routes file beside the controllers', () => {
    expect(
      RULES.controllers(app({ 'src/modules/news/news.routes.ts': '', 'app/routes.ts': '' })),
    ).toEqual([
      'src/modules/news/news.routes.ts registers routes outside a controller (name it *.controller.ts)',
    ]);
  });

  it('featureFiles: refuses a file not named after its feature', () => {
    expect(RULES.featureFiles(app({ 'src/modules/news/platform.controller.ts': '' }))).toHaveLength(
      1,
    );
  });

  it('moduleIndex: refuses a feature the index does not import the generated way', () => {
    const files = {
      'setu.config.ts': 'registerModules(app.router);',
      'src/modules/index.ts':
        "import { registerNewsRoutes } from './news/news.controller.ts';\nexport function registerModules() {}",
      'src/modules/news/news.controller.ts': '',
    };
    expect(RULES.moduleIndex(app(files), layout)).toEqual([
      'src/modules/index.ts does not import ./news/index.ts',
    ]);
  });

  it('moduleIndex: refuses feature folders with no module index', () => {
    expect(RULES.moduleIndex(app({ 'src/modules/news/news.controller.ts': '' }), layout)).toEqual([
      'has feature folders but no src/modules/index.ts',
    ]);
  });

  it('moduleIndex: refuses a module index that is imported but never called', () => {
    const files = {
      'setu.config.ts':
        "import { registerModules } from './src/modules/index.ts';\nexport function createApp() {}",
      'src/modules/index.ts':
        "import {} from './news/index.ts';\nexport function registerModules() {}",
      'src/modules/news/index.ts': '',
    };
    expect(RULES.moduleIndex(app(files), layout)).toEqual([
      'setu.config.ts does not use registerModules from src/modules/index.ts',
    ]);
  });

  it('moduleIndex: refuses a module index the composition never uses', () => {
    const files = {
      'setu.config.ts': 'export function createApp() {}',
      'src/modules/index.ts':
        "import {} from './news/index.ts';\nexport function registerModules() {}",
      'src/modules/news/index.ts': '',
    };
    expect(RULES.moduleIndex(app(files), layout)).toEqual([
      'setu.config.ts does not use registerModules from src/modules/index.ts',
    ]);
  });
});
