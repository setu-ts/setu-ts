/** Source policies and conservative upgrades consume the actual exported option types. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import { DEVTOOL_SOURCES } from '../fixtures/devtool-source-shapes.ts';
import {
  factoryScope,
  maskImportDeclarations,
  maskSourceCode,
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
      const fake of [
        '// $Cache(),',
        '/*\n$Cache(),\n*/',
        "const text = '\\n$Cache(),';",
        'const text = `\n$Cache(),\n`;',
      ]
    ) {
      const source = imports + signature + '\n' + fake + '\n $Cache(customOptions),\n}';
      const result = withDevtoolSourceWiring(source, new Set(['cache-plugin']));
      expect(result.source).toBe(source);
      expect(result.manual).toEqual(['$Cache({ ...options, ...sources.cache })']);
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
      ]
    ) {
      expect(maskSourceCode(source)).toBeUndefined();
    }
    const source =
      'const a = \'it\\\'s\'; /* block\r\ncomment */ const b = "double\\"quote"; // tail\r\nconst c = `template\\\nline`; // eof';
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
    const uses = (src: string) =>
      referencesIdentifier(maskImportDeclarations(maskSourceCode(src)!), 'CachePlugin');
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
