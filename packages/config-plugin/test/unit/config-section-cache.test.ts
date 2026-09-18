/** Tests for typed configuration-section cache boundaries. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IConfig } from '@setu-ts/common';

import { defineConfigSection, getConfigSection, loadConfig } from '../../src/index.ts';
import { createRuntime } from '../fixtures/fake-runtime.ts';

describe('typed configuration sections | cache', () => {
  it('keeps cached values isolated by configuration snapshot', async () => {
    const { z } = await import('npm:zod@^3.24.0');
    const database = defineConfigSection({
      prefix: 'DATABASE_',
      keys: ['URL'],
      schema: z.object({ URL: z.string() }),
    });

    const first = await loadConfig(
      createRuntime({ env: { DATABASE_URL: 'postgres://first/app' } }),
      { sections: [database] },
    );
    const second = await loadConfig(
      createRuntime({ env: { DATABASE_URL: 'postgres://second/app' } }),
      { sections: [database] },
    );

    expect(getConfigSection(first, database).URL).toBe('postgres://first/app');
    expect(getConfigSection(second, database).URL).toBe('postgres://second/app');
  });

  it('rejects a read for a definition that was not validated at startup', async () => {
    const { z } = await import('npm:zod@^3.24.0');
    const database = defineConfigSection({
      prefix: 'DATABASE_',
      keys: ['URL'],
      schema: z.object({ URL: z.string() }),
    });
    const config: IConfig = await loadConfig(
      createRuntime({ env: { DATABASE_URL: 'postgres://localhost/app' } }),
    );

    expect(() => getConfigSection(config, database)).toThrow(
      'Configuration section "DATABASE_" was not validated at startup.',
    );
  });

  it('snapshots a definition so caller mutations cannot change its cached section', async () => {
    const { z } = await import('npm:zod@^3.24.0');
    const definition = {
      prefix: 'DATABASE_',
      keys: ['URL'],
      schema: z.object({ URL: z.string() }),
    };
    const database = defineConfigSection(definition);
    const config = await loadConfig(
      createRuntime({ env: { DATABASE_URL: 'postgres://localhost/app' } }),
      { sections: [database] },
    );

    definition.prefix = 'OTHER_';
    definition.keys[0] = 'HOST';

    expect(database.prefix).toBe('DATABASE_');
    expect(database.keys).toEqual(['URL']);
    expect(Object.isFrozen(database)).toBe(true);
    expect(Object.isFrozen(database.keys)).toBe(true);
    expect(getConfigSection(config, database)).toEqual({ URL: 'postgres://localhost/app' });
  });
});
