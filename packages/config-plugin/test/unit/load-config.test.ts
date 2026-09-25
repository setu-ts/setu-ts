/**
 * Tests for `loadConfig` — the standalone loader and the plugin's own
 * implementation.
 *
 * The load path already had coverage through the plugin; what is new here is
 * that it is reachable without an application, and that BOTH entry points
 * honour the same options. A helper that quietly hardcoded a default while the
 * plugin honoured the configured value would pass every other test in this
 * package, so one case drives both under a non-default configuration and
 * compares the results.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  IConfig,
  IConfigDiagnosticsSource,
  IFileSystem,
  IPluginContext,
  IRuntimeServices,
} from '@setu-ts/common';

import { loadConfig } from '../../src/services/load-config.ts';
import { ConfigPlugin } from '../../src/plugin/config-plugin.ts';
import type { ConfigDiagnosticsOptions, ConfigPluginOptions } from '../../src/options.ts';
import { defineConfigSection } from '../../src/sections/config-section.ts';
import type { StructuralSchema } from '../../src/validators/config-validator.ts';
import { createFakeFileSystem, createRuntime } from '../fixtures/fake-runtime.ts';

/**
 * Registers the plugin over a minimal context and returns what it registered
 * under `CAPABILITIES.CONFIG`.
 *
 * The plugin touches `ctx.services` only, so the context is narrowed to it
 * rather than padded out with twelve unused APIs.
 */
async function registerPlugin(
  runtime: IRuntimeServices,
  options?: ConfigPluginOptions,
): Promise<IConfig> {
  const registry = new Map<string, unknown>();
  registry.set(CAPABILITIES.RUNTIME, runtime);

  const ctx = {
    services: {
      register(key: string, value: unknown): void {
        registry.set(key, value);
      },
      get(key: string): unknown {
        const value = registry.get(key);
        if (value === undefined) throw new Error(`Service not found: ${key}`);
        return value;
      },
      has(key: string): boolean {
        return registry.has(key);
      },
    },
  } as unknown as IPluginContext;

  await ConfigPlugin(options).register(ctx);
  return registry.get(CAPABILITIES.CONFIG) as IConfig;
}

/** A schema that coerces PORT to a number and defaults MODE, like Zod would. */
const coercingSchema: StructuralSchema<unknown> = {
  parse(input: unknown): Record<string, unknown> {
    const raw = input as Record<string, string>;
    return {
      ...raw,
      PORT: Number(raw['PORT']),
      MODE: raw['MODE'] ?? 'production',
    };
  },
};

describe('loadConfig | standalone loading', () => {
  it('builds a config over the runtime environment', async () => {
    const runtime = createRuntime({ env: { GREETING: 'hello', PORT: '8080' } });

    const config = await loadConfig(runtime);

    expect(config.get<string>('GREETING')).toBe('hello');
    expect(config.has('PORT')).toBe(true);
    expect(config.get<string>('MISSING')).toBeUndefined();
  });

  it('expands ${NAME} references by default', async () => {
    const runtime = createRuntime({ env: { HOST: 'db.internal', URL: 'postgres://${HOST}/app' } });

    const config = await loadConfig(runtime);

    expect(config.get<string>('URL')).toBe('postgres://db.internal/app');
  });

  it('leaves ${NAME} literal when expandVariables is false', async () => {
    const runtime = createRuntime({ env: { HOST: 'db.internal', URL: 'postgres://${HOST}/app' } });

    const config = await loadConfig(runtime, { expandVariables: false });

    expect(config.get<string>('URL')).toBe('postgres://${HOST}/app');
  });

  it('applies a validation schema, keeping its coercions and defaults', async () => {
    const runtime = createRuntime({ env: { PORT: '8080' } });

    const config = await loadConfig(runtime, { validationSchema: coercingSchema });

    expect(config.get<number>('PORT')).toBe(8080);
    expect(config.get<string>('MODE')).toBe('production');
  });

  it('reads env files through the runtime filesystem', async () => {
    const runtime = createRuntime({
      env: { FROM_ENV: 'env' },
      fs: createFakeFileSystem({ '.env': 'FROM_FILE=file\n' }),
    });

    const config = await loadConfig(runtime, { envFilePath: '.env' });

    expect(config.get<string>('FROM_FILE')).toBe('file');
    expect(config.get<string>('FROM_ENV')).toBe('env');
  });

  it('throws when envFilePath is set on a runtime without a filesystem', async () => {
    const runtime = createRuntime({ env: {} });

    await expect(loadConfig(runtime, { envFilePath: '.env' })).rejects.toThrow(
      'requires a runtime with filesystem support',
    );
  });
});

describe('loadConfig | instance short-circuit', () => {
  it('returns the supplied snapshot verbatim', async () => {
    const supplied: IConfig = {
      get: <T>(_key: string, options?: { readonly default?: T }): T | undefined => options?.default,
      getOrThrow: <T>(): T => {
        throw new Error('not used');
      },
      has: () => false,
    } as IConfig;

    const config = await loadConfig(createRuntime({ env: { A: '1' } }), { instance: supplied });

    expect(config).toBe(supplied);
  });

  it('reads no environment at all when an instance is supplied', async () => {
    // A runtime whose `env` throws on access: if any load step ran, this fails.
    const runtime = {
      get env(): Readonly<Record<string, string | undefined>> {
        throw new Error('environment must not be read when an instance is supplied');
      },
    } as unknown as IRuntimeServices;
    const supplied = { has: () => true } as unknown as IConfig;

    const config = await loadConfig(runtime, {
      instance: supplied,
      // Deliberately set alongside: these are documented as ignored.
      envFilePath: '.env',
      expandVariables: false,
      validationSchema: coercingSchema,
    });

    expect(config).toBe(supplied);
  });
});

describe('loadConfig | one implementation, two entry points', () => {
  it('the plugin registers exactly what the loader returns, under a non-default config', async () => {
    // Non-default on both switches: expansion off AND a coercing schema. A
    // helper hardcoding either default would diverge here and nowhere else.
    const options: ConfigPluginOptions = {
      expandVariables: false,
      validationSchema: coercingSchema,
    };
    const env = { HOST: 'db.internal', URL: 'postgres://${HOST}/app', PORT: '8080' };

    const standalone = await loadConfig(createRuntime({ env }), options);
    const registered = await registerPlugin(createRuntime({ env }), options);

    expect(registered.get<string>('URL')).toBe(standalone.get<string>('URL'));
    expect(registered.get<string>('URL')).toBe('postgres://${HOST}/app');
    expect(registered.get<number>('PORT')).toBe(standalone.get<number>('PORT'));
    expect(registered.get<number>('PORT')).toBe(8080);
    expect(registered.get<string>('MODE')).toBe('production');
  });

  it('the plugin registers an injected instance as the exact same object', async () => {
    const supplied = { has: () => true } as unknown as IConfig;

    const registered = await registerPlugin(createRuntime({ env: { A: '1' } }), {
      instance: supplied,
    });

    expect(registered).toBe(supplied);
  });

  it('the plugin reads no environment when an instance is supplied', async () => {
    const runtime = {
      get env(): Readonly<Record<string, string | undefined>> {
        throw new Error('environment must not be read when an instance is supplied');
      },
    } as unknown as IRuntimeServices;
    const supplied = { has: () => true } as unknown as IConfig;

    const registered = await registerPlugin(runtime, { instance: supplied });

    expect(registered).toBe(supplied);
  });
});

/**
 * `envFileOptional` — the arrangement a scaffolded project ships with.
 *
 * The CLI emits a GITIGNORED dotenv file, so it exists on the machine that ran
 * `setu new` and nowhere else: not in a fresh clone, not in CI, not in a
 * container built from the repository. Without this option the project throws
 * at `ConfigPlugin.register` in every one of those places, which is why the
 * absent case below is the one that matters.
 */
describe('loadConfig — optional dotenv files', () => {
  it('throws for an absent file by default, which is the released behaviour', async () => {
    const runtime = createRuntime({ env: {}, fs: createFakeFileSystem({}) });

    await expect(loadConfig(runtime, { envFilePath: '.env' })).rejects.toThrow(
      "unable to read env file '.env'",
    );
  });

  it('skips an absent file and still reads the environment when optional', async () => {
    const runtime = createRuntime({
      env: { MODE: 'production' },
      fs: createFakeFileSystem({}),
    });

    const config = await loadConfig(runtime, { envFilePath: '.env', envFileOptional: true });

    expect(config.get<string>('MODE')).toBe('production');
  });

  it('still throws when the file EXISTS but cannot be read', async () => {
    // The distinction the option is narrow about: absence is expected, an
    // unreadable file is a fault the developer needs told about. A `readFile`
    // catch could not tell these apart, so the implementation probes `stat`.
    const fs = createFakeFileSystem({ '.env': 'A=1' });
    const unreadable: IFileSystem = {
      ...fs,
      readFile: () => Promise.reject(new Error('Is a directory')),
    };

    await expect(
      loadConfig(createRuntime({ env: {}, fs: unreadable }), {
        envFilePath: '.env',
        envFileOptional: true,
      }),
    ).rejects.toThrow("unable to read env file '.env'");
  });

  it('loads the paths that exist from a list where others do not', async () => {
    const runtime = createRuntime({
      env: {},
      fs: createFakeFileSystem({ '.env': 'FROM_BASE=yes\nSHARED=base' }),
    });

    const config = await loadConfig(runtime, {
      envFilePath: ['.env.local', '.env'],
      envFileOptional: true,
    });

    expect(config.get<string>('FROM_BASE')).toBe('yes');
    expect(config.get<string>('SHARED')).toBe('base');
  });

  it('both entry points honour it identically', async () => {
    // The two-entry-point rule: the plugin must not hardcode a default the
    // standalone loader honours, or a scaffolded project and a hand-written one
    // would disagree about whether a missing dotenv file is fatal.
    const options: ConfigPluginOptions = { envFilePath: '.env', envFileOptional: true };
    const env = { MODE: 'production' };

    const standalone = await loadConfig(
      createRuntime({ env, fs: createFakeFileSystem({}) }),
      options,
    );
    const registered = await registerPlugin(
      createRuntime({ env, fs: createFakeFileSystem({}) }),
      options,
    );

    expect(registered.get<string>('MODE')).toBe(standalone.get<string>('MODE'));
    expect(registered.get<string>('MODE')).toBe('production');
  });
});

/** A registry-holding context like `registerPlugin`, returning the registry. */
async function registerFullPlugin(
  runtime: IRuntimeServices,
  options?: ConfigPluginOptions,
): Promise<Map<string, unknown>> {
  const registry = new Map<string, unknown>();
  registry.set(CAPABILITIES.RUNTIME, runtime);
  const ctx = {
    services: {
      register(key: string, value: unknown): void {
        registry.set(key, value);
      },
      get(key: string): unknown {
        const value = registry.get(key);
        if (value === undefined) throw new Error(`Service not found: ${key}`);
        return value;
      },
      has(key: string): boolean {
        return registry.has(key);
      },
    },
  } as unknown as IPluginContext;
  await ConfigPlugin(options).register(ctx);
  return registry;
}

/** Registers the plugin and returns the provenance source it registered. */
async function registerAndGetConfigSource(
  runtime: IRuntimeServices,
  options?: ConfigPluginOptions,
): Promise<IConfigDiagnosticsSource> {
  const registry = await registerFullPlugin(runtime, options);
  return registry.get(CAPABILITIES.CONFIG_DIAGNOSTICS) as IConfigDiagnosticsSource;
}

describe('loadConfig | configuration provenance (M98e)', () => {
  /** A counting IConfig double: every read is counted and returned. */
  function countingConfig(data: Record<string, unknown>): IConfig & { calls(): number } {
    const state = { calls: 0 };
    const hostile: IConfig = {
      get<T>(key: string): T | undefined {
        state.calls += 1;
        return data[key] as T | undefined;
      },
      getOrThrow<T>(key: string): T {
        state.calls += 1;
        const value = data[key];
        if (value === undefined) throw new Error('missing');
        return value as T;
      },
      has(key: string): boolean {
        state.calls += 1;
        return key in data;
      },
    };
    // A METHOD, not a getter: `Object.assign` copies a getter's VALUE, so a
    // getter added this way would freeze at its evaluation-time count.
    return Object.assign(hostile, {
      calls: () => state.calls,
    });
  }

  it('records real origins through the load, and the plugin serves the same record', async () => {
    const runtime = createRuntime({
      env: { PORT: '3000' },
      // The file also carries PORT, so the environment's win is a real
      // displacement the record can observe.
      fs: createFakeFileSystem({ '.env': 'HOST=base-host\nPORT=1000\n' }),
    });
    const options: ConfigPluginOptions = {
      envFilePath: ['.env'],
      diagnostics: {
        enabled: true,
        keys: { PORT: 'port', HOST: 'host' },
        files: { '.env': 'dotenv' },
      },
    };
    // ONE load: the standalone pass produces the snapshot, and the plugin
    // ADOPTS that exact instance's record — no second load, and the adopted
    // entries keep their real environment/file origins.
    const config = await loadConfig(runtime, options);
    const registry = await registerFullPlugin(
      createRuntime({ env: {}, fs: createFakeFileSystem({}) }),
      {
        instance: config,
        diagnostics: {
          enabled: true,
          keys: { PORT: 'port', HOST: 'host' },
          files: { '.env': 'dotenv' },
        },
      },
    );
    const snapshot = (registry.get(CAPABILITIES.CONFIG_DIAGNOSTICS) as IConfigDiagnosticsSource)
      .snapshot('instance-1');
    expect(snapshot.state).toEqual('ready');
    const byAlias = new Map(snapshot.entries.map((e) => [e.keyAlias, e]));
    expect(byAlias.get('port')).toMatchObject({
      origin: 'environment',
      overriddenSourceAliases: ['dotenv'],
      schemaEffect: 'not-configured',
    });
    expect(byAlias.get('host')).toMatchObject({
      origin: 'file',
      sourceAlias: 'dotenv',
      schemaEffect: 'not-configured',
    });
    // The adopted record follows the exact instance, not the plugin call.
    expect(config.get<string>('PORT')).toEqual('3000');
  });

  it('derives schema effects from presence: a default and a transform both report introduced', async () => {
    const runtime = createRuntime({ env: { PORT: '3000' }, fs: createFakeFileSystem({}) });
    const schema: StructuralSchema<unknown> = {
      parse(input: unknown): Record<string, unknown> {
        const raw = input as Record<string, string>;
        // MODE is a schema DEFAULT; DERIVED is a transform from PORT. Both
        // appear only after parsing — the identical presence pattern.
        return { ...raw, MODE: raw['MODE'] ?? 'production', DERIVED: `${raw['PORT']}-x` };
      },
    };
    const source = await registerAndGetConfigSource(runtime, {
      validationSchema: schema,
      diagnostics: { enabled: true, keys: { PORT: 'port', MODE: 'mode', DERIVED: 'derived' } },
    });
    const byAlias = new Map(source.snapshot('i').entries.map((e) => [e.keyAlias, e]));
    expect(byAlias.get('port')!.schemaEffect).toEqual('validated');
    expect(byAlias.get('mode')).toMatchObject({ origin: 'unknown', schemaEffect: 'introduced' });
    expect(byAlias.get('derived')).toMatchObject({ origin: 'unknown', schemaEffect: 'introduced' });
  });

  it('carries expansion evidence only when both endpoints are approved', async () => {
    const source = await registerAndGetConfigSource(
      createRuntime({ env: { A: 'a', B: 'prefix-${A}' }, fs: createFakeFileSystem({}) }),
      { diagnostics: { enabled: true, keys: { A: 'a', B: 'b', SECRET_X: 'sx' } } },
    );
    const byAlias = new Map(source.snapshot('i').entries.map((e) => [e.keyAlias, e]));
    expect(byAlias.get('b')).toMatchObject({ expanded: true, referenceAliases: ['a'] });
    expect(byAlias.get('a')!.expanded).toBe(false);
    // SECRET_X was approved but never present: no entry, no count.
    expect(byAlias.size).toEqual(2);
  });

  it('adds no read to an injected instance: section calls are identical, diagnostics on or off', async () => {
    const data = { DATABASE_URL: 'x', DATABASE_USER: 'u' };
    const section = defineConfigSection({
      prefix: 'DATABASE_',
      keys: ['URL', 'USER'],
      schema: { parse: (v: unknown) => v },
    });
    const withoutDiagnostics = countingConfig(data);
    const withDiagnostics = countingConfig(data);
    await registerFullPlugin(createRuntime({}), {
      instance: withoutDiagnostics,
      sections: [section],
    });
    await registerFullPlugin(createRuntime({}), {
      instance: withDiagnostics,
      sections: [section],
      diagnostics: { enabled: true, keys: { DATABASE_URL: 'url' } },
    });
    // The section reads are the ONLY reads; provenance adds none.
    expect(withDiagnostics.calls()).toEqual(withoutDiagnostics.calls());
    expect(withDiagnostics.calls()).toBeGreaterThan(0);
  });

  it('answers an opaque injected instance with unknown entries and no extra reads', async () => {
    const opaque = countingConfig({ PORT: '3000' });
    const registry = await registerFullPlugin(createRuntime({}), {
      instance: opaque,
      diagnostics: { enabled: true, keys: { PORT: 'port', OTHER: 'other' } },
    });
    const readsBefore = opaque.calls();
    const source = registry.get(CAPABILITIES.CONFIG_DIAGNOSTICS) as IConfigDiagnosticsSource;
    const snapshot = source.snapshot('i');
    expect(opaque.calls()).toEqual(readsBefore);
    expect(snapshot.entries).toEqual([
      {
        keyAlias: 'port',
        origin: 'unknown',
        overriddenSourceAliases: [],
        expanded: false,
        referenceAliases: [],
        schemaEffect: 'unknown',
      },
      {
        keyAlias: 'other',
        origin: 'unknown',
        overriddenSourceAliases: [],
        expanded: false,
        referenceAliases: [],
        schemaEffect: 'unknown',
      },
    ]);
  });

  it('registers the disabled inert source when the diagnostics option is absent', async () => {
    const registry = await registerFullPlugin(
      createRuntime({ env: { PORT: '3000' }, fs: createFakeFileSystem({}) }),
      {},
    );
    const source = registry.get(CAPABILITIES.CONFIG_DIAGNOSTICS) as IConfigDiagnosticsSource;
    expect(source.snapshot('i')).toMatchObject({ state: 'disabled', entries: [] });
  });

  it('refuses an invalid diagnostics option before anything is read', async () => {
    const runtime = createRuntime({ env: {}, fs: createFakeFileSystem({}) });
    await expect(loadConfig(runtime, {
      diagnostics: { enabled: false, keys: {} } as unknown as ConfigDiagnosticsOptions,
    })).rejects.toThrow(/enabled must be the literal true/);
  });
});
