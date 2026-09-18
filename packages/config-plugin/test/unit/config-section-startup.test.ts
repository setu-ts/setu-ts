/** Tests for typed configuration-section startup validation. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IConfig } from '@setu-ts/common';

import { defineConfigSection, getConfigSection, loadConfig } from '../../src/index.ts';
import { createRuntime } from '../fixtures/fake-runtime.ts';

describe('typed configuration sections | startup validation', () => {
  it('rejects an invalid section without disclosing the rejected value or cause', async () => {
    const { z } = await import('npm:zod@^3.24.0');
    const application = defineConfigSection({
      prefix: 'APP_',
      keys: ['MODE'],
      schema: z.object({ MODE: z.enum(['development', 'production']) }),
    });

    const error = await loadConfig(
      createRuntime({ env: { APP_MODE: 'secret-invalid-mode' } }),
      { sections: [application] },
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Configuration section "APP_" validation failed.');
    expect((error as Error).message).not.toContain('secret-invalid-mode');
    expect((error as Error).cause).toBeUndefined();
  });

  it('validates a supplied IConfig instance through declared named reads', async () => {
    const { z } = await import('npm:zod@^3.24.0');
    const database = defineConfigSection({
      prefix: 'DATABASE_',
      keys: ['PORT'],
      schema: z.object({ PORT: z.coerce.number().int() }),
    });
    const instance = createInjectedConfig({ DATABASE_PORT: '5432' });

    const config = await loadConfig(createRuntime({ env: {} }), {
      instance,
      sections: [database],
    });

    expect(config).toBe(instance);
    expect(getConfigSection(config, database)).toEqual({ PORT: 5432 });
  });

  it('does not reparse a section after startup', async () => {
    const { z } = await import('npm:zod@^3.24.0');
    let parses = 0;
    const application = defineConfigSection({
      prefix: 'APP_',
      keys: ['PORT'],
      schema: z.object({ PORT: z.coerce.number() }).transform((value) => {
        parses += 1;
        return value;
      }),
    });

    const config = await loadConfig(createRuntime({ env: { APP_PORT: '3000' } }), {
      sections: [application],
    });

    expect(getConfigSection(config, application).PORT).toBe(3000);
    expect(getConfigSection(config, application).PORT).toBe(3000);
    expect(parses).toBe(1);
  });

  it('clears an injected snapshot cache when a later validation fails', async () => {
    const { z } = await import('npm:zod@^3.24.0');
    const application = defineConfigSection({
      prefix: 'APP_',
      keys: ['MODE'],
      schema: z.object({ MODE: z.enum(['development', 'production']) }),
    });
    const values: Record<string, unknown> = { APP_MODE: 'production' };
    const instance = createInjectedConfig(values);

    await loadConfig(createRuntime({ env: {} }), { instance, sections: [application] });
    expect(getConfigSection(instance, application)).toEqual({ MODE: 'production' });

    values['APP_MODE'] = 'invalid';
    await expect(
      loadConfig(createRuntime({ env: {} }), { instance, sections: [application] }),
    ).rejects.toThrow('Configuration section "APP_" validation failed.');
    expect(() => getConfigSection(instance, application)).toThrow(
      'Configuration section "APP_" was not validated at startup.',
    );
  });
});

function createInjectedConfig(data: Readonly<Record<string, unknown>>): IConfig {
  return {
    get<T>(key: string, options?: { readonly default: T }): T | undefined {
      const value = data[key];
      return value === undefined ? options?.default : value as T;
    },
    getOrThrow<T>(key: string): T {
      const value = data[key];
      if (value === undefined) throw new Error(`Configuration key "${key}" is not set.`);
      return value as T;
    },
    has(key: string): boolean {
      return data[key] !== undefined;
    },
  };
}
