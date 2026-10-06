/** Source policies and conservative upgrades consume the actual exported option types. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import { DEVTOOL_SOURCES } from '../fixtures/devtool-source-shapes.ts';
import {
  factoryScope,
  maskComments,
  maskImportDeclarations,
  maskSourceCode,
  packageSpecifierCount,
  readDevtoolSourceNames,
  referencesIdentifier,
  renderDevtoolSources,
  withDevtoolSourceWiring,
  withSourceArgs,
} from '../../src/devtool/sources.ts';

const packages = new Set([
  'cache-plugin',
  'storage-plugin',
  'websocket-plugin',
  'sse-plugin',
  'realtime-backplane-plugin',
  'events-plugin',
  'scheduler-plugin',
  'queue-plugin',
  'health-plugin',
  'config-plugin',
  'telemetry-plugin',
  'auth-plugin',
]);
const signature = `export function createApp(
  _env?: Readonly<Record<string, unknown>>,
  devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions },
): IKernelApplication {`;

describe('development source policies', () => {
  it('emits every supported option against its exported type', async () => {
    const emitted = renderDevtoolSources(packages, { project: 'shop', authorization: true });
    const fixture = await Deno.readTextFile(
      new URL('../fixtures/devtool-source-shapes.ts', import.meta.url),
    );
    const normalized = (text: string) => text.replace(/,\s*}/g, '}').replace(/\s/g, '');
    expect(normalized(emitted.contents)).toBe(normalized(fixture));
    for (const key of Object.keys(DEVTOOL_SOURCES)) {
      expect(emitted.contents).toContain(`  ${key}: {`);
    }
    expect(Object.keys(DEVTOOL_SOURCES)).toHaveLength(12);
    expect(emitted.managed).toBe(true);
    expect(emitted.contents).toContain('SDK createObservedFetch');
  });

  it('approves known names and excludes unsafe, duplicate and excessive aliases', () => {
    const emitted = renderDevtoolSources(packages, {
      project: "hostile'\nproject",
      authorization: true,
      artifacts: {
        'health-indicator': ['external-api'],
        'event-handler': ['created', 'created', "evil'\n", '__proto__'],
        job: Array.from({ length: 70 }, (_, i) => `job-${i}`),
      },
      envKeys: ['PUBLIC_PORT', 'TOKEN\u202e', 'x'.repeat(65)],
    });
    expect(emitted.contents).toContain("serviceAlias: 'app'");
    expect(emitted.contents).toContain("'external-api': 'external-api'");
    expect(emitted.contents).toContain("'created': 'created'");
    expect(emitted.contents).toContain("'PUBLIC_PORT': 'PUBLIC_PORT'");
    expect(emitted.contents).not.toContain('evil');
    expect(emitted.contents).not.toContain('__proto__');
    expect(emitted.contents).not.toContain('TOKEN');
    expect(emitted.contents.match(/'job-\d+':/g)).toHaveLength(64);
  });

  it('omits unsupported auth and custom backplane sources', () => {
    const emitted = renderDevtoolSources(packages, { project: 'shop', customBackplane: true });
    expect(emitted.contents).not.toContain('authorizationDiagnostics');
    expect(emitted.contents).not.toContain('  backplane:');
    expect(renderDevtoolSources(new Set(), { project: 'app' }).contents).toContain(
      'DEVTOOL_SOURCES = {};',
    );
    expect(withSourceArgs('runtime', '', packages, { project: 'app' })).toBe('');
  });

  it('gates known zero-option and object-option calls on the devtool argument', () => {
    const source = "import { CachePlugin as AppCache } from '@setu-ts/cache-plugin';\n" +
      "import { HealthPlugin } from '@setu-ts/health-plugin';\n" + signature +
      '\n return createApplication({ plugins: [\n  AppCache(),\n  HealthPlugin({ indicators: [] }),\n] });\n}';
    const wired = withDevtoolSourceWiring(source, new Set(['cache-plugin', 'health-plugin']));
    expect(wired.manual).toEqual([]);
    expect(wired.source).toContain('devtool === undefined ? {} : DEVTOOL_SOURCES');
    expect(wired.source).toContain('...sources.cache');
    expect(wired.source).toContain('...{ indicators: [] }, ...sources.health');
    expect(withDevtoolSourceWiring(wired.source, new Set(['cache-plugin', 'health-plugin'])).source)
      .toBe(wired.source);
  });

  it('never rewrites plugin examples inside comments, literals or unfamiliar calls', () => {
    const imports = "import { CachePlugin as $Cache } from '@setu-ts/cache-plugin';\n";
    for (
      const fake of ['// $Cache(),', '/*\n$Cache(),\n*/', "const text = '$Cache(),';"]
    ) {
      const source = imports + signature + '\n' + fake + '\n $Cache(customOptions),\n}';
      const result = withDevtoolSourceWiring(source, new Set(['cache-plugin']));
      expect(result.source).toBe(source);
      expect(result.manual).toEqual(['$Cache({ ...options, ...sources.cache })']);
    }
    // An escape or a template literal in code is outside the language the lexer
    // classifies exactly, so the whole configuration is refused rather than edited.
    for (const fake of ["const text = '\\n$Cache(),';", 'const text = `\n$Cache(),\n`;']) {
      const source = imports + signature + '\n' + fake + '\n $Cache(),\n}';
      const result = withDevtoolSourceWiring(source, new Set(['cache-plugin']));
      expect(result.source).toBe(source);
      expect(result.manual).toEqual(['CachePlugin({ ...options, ...sources.cache })']);
    }
    const source = imports + '// ): IKernelApplication {\n' + signature +
      '\n // ...sources.cache\n $Cache(),\n}';
    const result = withDevtoolSourceWiring(source, new Set(['cache-plugin']));
    expect(result.source).toContain('// ): IKernelApplication {\n');
    expect(result.source).toContain('$Cache({ ...sources.cache })');
  });

  it('preserves source positions while refusing incomplete literals and comments', () => {
    for (
      const source of [
        "'unterminated",
        '"unterminated',
        '`unterminated',
        '/* unterminated',
        "'trailing\\",
        // Outside the exactly-classified language: escapes, templates, a backslash
        // in code, a raw line break inside a string.
        "const a = 'it\\'s';",
        'const b = `template`;',
        'const c = \\u0061;',
        "const d = 'line\nbreak';",
      ]
    ) {
      expect(maskSourceCode(source)).toBeUndefined();
      expect(maskComments(source)).toBeUndefined();
    }
    const source =
      'const a = \'its\'; /* block\r\ncomment `x` \\ */ const b = "double"; // tail `y`\r\nconst c = 1; // eof';
    const masked = maskSourceCode(source)!;
    expect(masked.length).toBe(source.length);
    expect(masked.match(/[\r\n]/g)).toEqual(source.match(/[\r\n]/g));
    expect(masked).toContain('const a =');
    expect(masked).not.toContain('unterminated');
    const commentedImport = "/*\nimport { CachePlugin } from '@setu-ts/cache-plugin';\n*/\n" +
      signature + '\n CachePlugin(),\n}';
    expect(withDevtoolSourceWiring(commentedImport, new Set(['cache-plugin'])).source).toBe(
      commentedImport,
    );
  });

  it('preserves module-scope calls and selects only the complete createApp body', () => {
    const outside = 'const reusedCache = [\n  CachePlugin(),\n];\n';
    const source = "import { CachePlugin } from '@setu-ts/cache-plugin';\n" + outside +
      signature + '\n CachePlugin(customOptions),\n}\n' + outside;
    const result = withDevtoolSourceWiring(source, new Set(['cache-plugin']));
    expect(result.source).toBe(source);
    expect(result.manual).toEqual(['CachePlugin({ ...options, ...sources.cache })']);
    for (
      const incomplete of [
        "'broken",
        'export function createApp(',
        'export function createApp(): Promise<IKernelApplication> {',
        'export function createApp() {',
      ]
    ) {
      expect(factoryScope(incomplete)).toBeUndefined();
    }
    const nested =
      "export function createApp(env = read(() => ({ value: ')' }))) { return { literal: '}' }; }";
    expect(factoryScope(nested)?.code.slice(factoryScope(nested)!.start, factoryScope(nested)!.end))
      .toContain('return { literal:');
  });

  it('leaves unclassified factories and calls untouched and names the manual option', () => {
    const unclassified = withDevtoolSourceWiring('handwritten()', packages);
    expect(unclassified.source).toBe('handwritten()');
    expect(unclassified.manual).toContain('CachePlugin({ ...options, ...sources.cache })');
    const source = "import { CachePlugin } from '@setu-ts/cache-plugin';\n" + signature +
      '\n CachePlugin(options),\n}';
    expect(withDevtoolSourceWiring(source, new Set(['cache-plugin'])).source).toContain(
      'CachePlugin(options)',
    );
    expect(withDevtoolSourceWiring(source, new Set(['cache-plugin'])).manual).toHaveLength(1);
    expect(withDevtoolSourceWiring(signature + '\n}', new Set(['cache-plugin'])).manual)
      .toHaveLength(1);
    const dollarAlias = "import { CachePlugin as $Cache } from '@setu-ts/cache-plugin';\n" +
      signature + '\n $Cache(),\n}';
    expect(withDevtoolSourceWiring(dollarAlias, new Set(['cache-plugin'])).source)
      .toContain('$Cache({ ...sources.cache })');
    const hostileAlias = "import { CachePlugin as Evil\u202e } from '@setu-ts/cache-plugin';\n" +
      signature + '\n Evil(),\n}';
    const refused = withDevtoolSourceWiring(hostileAlias, new Set(['cache-plugin']));
    expect(refused.source).toBe(hostileAlias);
    expect(refused.manual.join('\n')).not.toContain('\u202e');
  });

  it('refuses slash expressions rather than extending scope through regex braces', () => {
    const imports = "import { CachePlugin as $Cache } from '@setu-ts/cache-plugin';\n";
    for (const expression of ['/ { /', '/{/', '/}/', '/[{}]/', '8 / 2', '8 /= 2']) {
      const source = imports + signature + '\n const expression = ' + expression +
        ';\n return createApplication({ plugins: [$Cache(customOptions)] });\n}\n' +
        'const reused = [\n $Cache(),\n];\nconst closing = /}/;';
      const result = withDevtoolSourceWiring(source, new Set(['cache-plugin']));
      expect(result.source).toBe(source);
      expect(result.manual).toEqual(['CachePlugin({ ...options, ...sources.cache })']);
      expect(factoryScope(source)).toBeUndefined();
      expect(maskSourceCode(source)).toBeUndefined();
    }
  });

  it('reads artifact, job and env names without executing the project', async () => {
    const fs = createFakeFs({
      '/shop/.env.example': '# credentials never copied\nPORT=3000\nSECRET=secret-value\n',
      '/shop/src/jobs/billing.job.ts': 'export async function runBillingJob() {}',
      '/shop/src/jobs/readme.md': 'ignored',
    });
    const names = await readDevtoolSourceNames(fs, '/shop', packages, 'rbac: {}');
    expect(names.envKeys).toEqual(['PORT', 'SECRET']);
    expect(names.artifacts?.['job']).toEqual(['billing']);
    expect(names.authorization).toBe(true);
    expect(renderDevtoolSources(packages, names).contents).not.toContain('secret-value');
    const absent = await readDevtoolSourceNames(createFakeFs(), '/shop', new Set(), '');
    expect(absent.envKeys).toEqual([]);
    const decorated = await readDevtoolSourceNames(fs, '/shop', new Set(['decorator-plugin']), '');
    expect(decorated.artifacts?.['job']).toBeUndefined();
    const custom = await readDevtoolSourceNames(
      createFakeFs({ '/shop/config/local.env.example': 'CUSTOM_KEY=canary-env-value\n' }),
      '/shop',
      packages,
      "envFilePath: 'config/local.env'",
    );
    expect(custom.envKeys).toEqual(['CUSTOM_KEY']);
    expect(renderDevtoolSources(packages, custom).contents).not.toContain('canary-env-value');
    const escaped = await readDevtoolSourceNames(fs, '/shop', packages, "envFilePath: '../other'");
    expect(escaped.envKeys).toEqual(['PORT', 'SECRET']);
    const customTransport = await readDevtoolSourceNames(
      fs,
      '/shop',
      packages,
      'transport: "custom"',
    );
    expect(customTransport.customBackplane).toBe(true);
    for (const expression of ['8 / 2', '/{/', "'unterminated"]) {
      const unknown = await readDevtoolSourceNames(
        fs,
        '/shop',
        packages,
        "rbac: {}, transport: 'custom'; const expression = " + expression,
      );
      expect(unknown.customBackplane).toBe(true);
      expect(unknown.authorization).toBe(false);
      const policy = renderDevtoolSources(packages, unknown).contents;
      expect(policy).not.toContain('  backplane:');
      expect(policy).not.toContain('authorizationDiagnostics');
      expect(policy).toContain('  cache:');
    }
    // Commented examples are not configuration: a real, confirmed backplane call
    // beside a commented custom one still emits the policy.
    const examples = await readDevtoolSourceNames(
      fs,
      '/shop',
      packages,
      "import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';\n" +
        '// rbac: {}\n// RealtimeBackplanePlugin({ transport: "custom" })\n' +
        'const plugins = [RealtimeBackplanePlugin()];',
    );
    expect(examples.authorization).toBe(false);
    expect(examples.customBackplane).toBe(false);
  });

  it('masks import declarations by grammar, never across unrelated code', () => {
    // The scanner itself, on raw text: none of these specifiers mentions the name.
    const uses = (src: string) => referencesIdentifier(maskImportDeclarations(src), 'CachePlugin');
    expect(uses("import { CachePlugin } from 'x';\n")).toBe(false);
    expect(uses("import {\n  CachePlugin,\n  Other,\n} from 'x';\n")).toBe(false);
    expect(uses("import type { CachePlugin } from 'x';\nimport D, * as ns from 'y';\n")).toBe(
      false,
    );
    // A lazy match to the next `from` would swallow this reference.
    expect(uses("import './x.ts'\nconst c = CachePlugin;\nconst a = Array.from([]);\n")).toBe(true);
    expect(uses("import { CachePlugin } from 'x';\nconst c = CachePlugin();\n")).toBe(true);
    expect(uses("const m = await import('x');\nm.CachePlugin();\n")).toBe(false);
    expect(uses('const RedisCachePlugin = 1;\nconst y = CachePluginX;\n')).toBe(false);
    expect(uses('const spread = [...CachePlugin()];\n')).toBe(true);
  });

  it('keeps literals in the comment-only mask and classifies like the full mask', () => {
    const source = "const a = 'CachePlugin'; // note `x`\nconst b = f(1);\n";
    expect(maskComments(source)).toBe(
      "const a = 'CachePlugin'; " + ' '.repeat('// note `x`'.length) + '\nconst b = f(1);\n',
    );
    expect(maskSourceCode(source)).not.toContain('CachePlugin');
    expect(maskComments("const a = 'unterminated")).toBeUndefined();
    expect(maskComments('const a = 8 / 2;')).toBeUndefined();
    expect(maskComments('const b = `${f(CachePlugin())}`;')).toBeUndefined();
  });

  it('counts a package by every specifier spelling and nothing longer', () => {
    const count = (text: string) => packageSpecifierCount(text, 'cache-plugin');
    expect(count("import { A } from '@setu-ts/cache-plugin';")).toBe(1);
    expect(count('import * as a from "@setu-ts/cache-plugin";')).toBe(1);
    expect(count("import * as a from 'jsr:@setu-ts/cache-plugin@^0.8.0';")).toBe(1);
    expect(count("import * as a from 'npm:@jsr/setu-ts__cache-plugin@0.8.0';")).toBe(1);
    expect(count("import * as a from '@setu-ts/cache-plugin/sub';")).toBe(1);
    expect(count("import x from '@setu-ts/cache-plugin-x';")).toBe(0);
    expect(count("import x from '@setu-ts/cache-plugins';")).toBe(0);
    // Callers pass comment-masked text, so a comment never counts.
    expect(count(maskComments('// @setu-ts/cache-plugin is installed\n')!)).toBe(0);
  });

  it('scans import clauses in linear time and refuses non-import text', () => {
    // A regex here backtracked cubically: 10,000 spaces took 104 s (audit round 3).
    const hostile = 'import X' + ' '.repeat(100_000) + '\n' +
      ('import ' + ' '.repeat(50) + '\n').repeat(2000);
    const started = performance.now();
    maskImportDeclarations(hostile);
    expect(performance.now() - started).toBeLessThan(5000);
    // Past the scan bound, or not import syntax: left visible (fail closed).
    expect(maskImportDeclarations('import X' + ' '.repeat(5000) + 'from x')).toContain('import X');
    expect(maskImportDeclarations('import X = require("y");')).toContain('import X');
    expect(maskImportDeclarations('import from;')).toContain('import from');
    expect(maskImportDeclarations("import('x');")).toContain('import');
    expect(maskImportDeclarations("import { a } from 'x';").trim()).toBe("'x';");
  });

  // Audit round 5: the lexer must be exact for everything it classifies, and the
  // configuration's meaning must be decidable from its own text. Each row below is
  // outside that language and must be refused, not parsed.
  it('refuses every construct outside the decidable language', () => {
    const refused: readonly string[] = [
      "const s = 'a\u2028b';",
      '#!/usr/bin/env deno\nconst a = 1;',
      'class A { #x = 1; }',
      '<!-- x\nconst a = 1;',
      'const a = 1;\n--> x',
      'const éa = 1;',
      "const ns = await import('@setu-ts/' + 'cache-plugin');",
      "import * as cp from 'cachealias';",
      "import * as cp from /* note */ 'cachealias';",
      "import 'side-effect';",
      "export { a } from 'bare';",
      ...[
        'Object',
        'Reflect',
        'Proxy',
        'constructor',
        'prototype',
        '__proto__',
        'setPrototypeOf',
        'defineProperty',
        'defineProperties',
        'globalThis',
        'self',
        'window',
        'eval',
        'Function',
        'require',
      ].map((name) => `const v = ${name};`),
    ];
    for (const source of refused) {
      expect(maskSourceCode(source), source).toBeUndefined();
      expect(maskComments(source), source).toBeUndefined();
    }
    const classified: readonly string[] = [
      "import { A } from '@setu-ts/cache-plugin';",
      "import { A } from './local.ts';",
      "import { A } from '../up.ts';",
      'const meta = import.meta.url;',
      '// comment with — non-ASCII, `ticks`, \\ and #!\nconst a = 1;',
      '/* Object.assign(globalThis) */ const a = 1;',
    ];
    for (const source of classified) expect(maskSourceCode(source), source).toBeDefined();
    // U+2028/U+2029 end a line comment exactly as a newline does: what follows is code.
    for (const separator of ['\u2028', '\u2029']) {
      expect(maskSourceCode(`// note${separator}const c = f();`)).toContain('const c = f();');
    }
  });

  it('scans the factory signature in linear time', () => {
    const source = 'export function createApp()' + ' '.repeat(150_000) +
      ': IKernelApplication & object {\n}';
    const started = performance.now();
    expect(factoryScope(source)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(5000);
    expect(factoryScope('export function createApp()   :   IKernelApplication   {\n}'))
      .toBeUndefined();
    expect(factoryScope('export function createApp() : IKernelApplication {\n}')).toBeDefined();
    expect(factoryScope('export function createApp()\n  : IApplication\n  {\n}')).toBeDefined();
  });

  it('never rescans text an import scan already passed', () => {
    // Without the resume index, each of these lines rescans the next 4 KiB: ~12 s.
    const lines = ('import {' + ' '.repeat(40) + '\n').repeat(40_000);
    const started = performance.now();
    maskImportDeclarations(lines);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('withholds the backplane policy for call shapes it cannot classify', async () => {
    const fs = createFakeFs({});
    const custom = async (config: string) =>
      (await readDevtoolSourceNames(fs, '/shop', packages, config)).customBackplane === true;
    const head = "import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';\n";
    for (
      const tail of [
        'const p = RealtimeBackplanePlugin(',
        'const p = RealtimeBackplanePlugin(]',
        "const p = RealtimeBackplanePlugin('memory');",
        'const p = RealtimeBackplanePlugin({}, extra);',
        "const p = RealtimeBackplanePlugin({ transport: 'redis' } as Options);",
        'type T = typeof RealtimeBackplanePlugin;',
      ]
    ) expect(await custom(head + tail), tail).toBe(true);
    for (
      const declaration of [
        "import { RealtimeBackplanePlugin as 1x } from '@setu-ts/realtime-backplane-plugin';\n",
        "import { Other } from '@setu-ts/realtime-backplane-plugin';\n",
        "// import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';\n",
      ]
    ) {
      expect(await custom(`${declaration}const p = RealtimeBackplanePlugin();`), declaration).toBe(
        true,
      );
    }
    // An alias that is a valid identifier is followed through.
    expect(
      await custom(
        "import { RealtimeBackplanePlugin as Rb } from '@setu-ts/realtime-backplane-plugin';\n" +
          'const p = Rb();',
      ),
    ).toBe(false);
  });

  // Security audit L2 (rounds 1 and 2): the policy is emitted only when the
  // configuration CONFIRMS a supported transport. Each spelling below was a real
  // bypass of a narrower recognizer, so the table is the specification.
  it('emits the backplane policy only for a confirmed supported transport', async () => {
    const fs = createFakeFs({});
    const imported =
      "import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';\n";
    const custom = async (config: string) =>
      (await readDevtoolSourceNames(fs, '/shop', packages, config)).customBackplane === true;
    const confirmed: readonly string[] = [
      'RealtimeBackplanePlugin()',
      "RealtimeBackplanePlugin({ transport: 'redis', url: 'redis://127.0.0.1:6379' })",
      'RealtimeBackplanePlugin({ transport: "memory" })',
      'RealtimeBackplanePlugin({})',
    ];
    for (const call of confirmed) {
      expect(await custom(`${imported}const p = [${call}];`), call).toBe(false);
    }
    const withheld: readonly string[] = [
      "RealtimeBackplanePlugin({ transport: 'custom', backplane })",
      "RealtimeBackplanePlugin({ 'transport': 'custom' })",
      'RealtimeBackplanePlugin({ "transport": "custom" })',
      "RealtimeBackplanePlugin({ ['transport']: 'custom' })",
      'RealtimeBackplanePlugin({ transport })',
      'RealtimeBackplanePlugin({ ...opts })',
      "RealtimeBackplanePlugin({ transport: '\\x63ustom' })",
      "RealtimeBackplanePlugin({ transport: '' as string || 'custom' })",
      'RealtimeBackplanePlugin({ transport: `custom` })',
      'RealtimeBackplanePlugin(opts)',
      "RealtimeBackplanePlugin({ get transport() { return 'custom'; } })",
      "RealtimeBackplanePlugin({ tr\\u0061nsport: 'custom' })",
      'RealtimeBackplanePlugin({ transport: kind })',
    ];
    for (const call of withheld) {
      expect(await custom(`${imported}const p = [${call}];`), call).toBe(true);
    }
    // Audit round 3: a custom call hidden in a template substitution, a second
    // import form, a prototype carrying the transport, or a non-call reference
    // BESIDE a confirmed call each withholds the policy.
    for (
      const config of [
        `${imported}const p = [RealtimeBackplanePlugin()];\n` +
        "const t = `${RealtimeBackplanePlugin({ transport: 'custom', backplane })}`;",
        `${imported}import { RealtimeBackplanePlugin as X } from "@setu-ts/realtime-backplane-plugin";\n` +
        "const p = [RealtimeBackplanePlugin(), X({ transport: 'custom' })];",
        `${imported}const p = [RealtimeBackplanePlugin({ __proto__: proto })];`,
        `${imported}const make = RealtimeBackplanePlugin;\n` +
        "const p = [RealtimeBackplanePlugin(), make({ transport: 'custom' })];",
        `${imported}type T = typeof RealtimeBackplanePlugin;\nconst p = [RealtimeBackplanePlugin()];`,
        // A reference followed directly by a balanced `{…}` is the one shape only
        // the call guard refuses: without it this reads as a call with no argument.
        `${imported}class X extends RealtimeBackplanePlugin {}\nconst p = [RealtimeBackplanePlugin()];`,
        // Audit round 4: an escaped alias, a `jsr:` second import, or a template
        // hiding a custom call — each beside a dead plain call.
        `${imported}const p = [RealtimeBackplanePlugin(), R\\u0065altimeBackplanePlugin({ transport: 'custom', backplane })];`,
        `${imported}import { RealtimeBackplanePlugin as X } from 'jsr:@setu-ts/realtime-backplane-plugin@^0.8.0';\n` +
        "const p = [RealtimeBackplanePlugin(), X({ transport: 'custom', backplane })];",
        `${imported}const o = \`\${\`/*\`}\`;\nconst c = RealtimeBackplanePlugin({ transport: 'custom', backplane });\n// */\n` +
        'const p = [RealtimeBackplanePlugin()];',
      ]
    ) expect(await custom(config), config).toBe(true);
    // Audit round 5: prototype or global mutation, an import-map alias, and a call
    // hidden behind a U+2028-terminated comment each withhold the policy.
    for (
      const config of [
        `${imported}Object.assign(Object.prototype, { transport: 'custom', backplane: x });\n` +
        'const p = [RealtimeBackplanePlugin({})];',
        `${imported}({}).constructor.prototype.transport = 'custom';\n` +
        'const p = [RealtimeBackplanePlugin({})];',
        `${imported}import { RealtimeBackplanePlugin as X } from 'rbalias';\n` +
        "const p = [RealtimeBackplanePlugin(), X({ transport: 'custom', backplane })];",
        `${imported}// note\u2028const c = RealtimeBackplanePlugin({ transport: 'custom', backplane });\n` +
        'const p = [RealtimeBackplanePlugin()];',
      ]
    ) expect(await custom(config), config).toBe(true);
    // An alias, a second import form, or no import at all confirms nothing.
    expect(await custom(`${imported}const make = RealtimeBackplanePlugin;\nmake({});`)).toBe(true);
    expect(
      await custom(
        `${imported}import * as rb from '@setu-ts/realtime-backplane-plugin';\n` +
          'const p = [RealtimeBackplanePlugin()];',
      ),
    ).toBe(true);
    expect(await custom('const p = [RealtimeBackplanePlugin()];')).toBe(true);
    expect(await custom(`${imported}const unused = 1;`)).toBe(true);
    const policy = renderDevtoolSources(packages, { project: 'shop', customBackplane: true })
      .contents;
    expect(policy).not.toContain('  backplane:');
  });
});
