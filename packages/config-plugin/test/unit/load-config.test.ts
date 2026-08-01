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
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IConfig, IPluginContext, IRuntimeServices } from '@hono-enterprise/common';

import { loadConfig } from '../../src/services/load-config.ts';
import { ConfigPlugin } from '../../src/plugin/config-plugin.ts';
import type { ConfigPluginOptions } from '../../src/options.ts';
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
