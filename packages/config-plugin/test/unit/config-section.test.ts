/** Tests for typed configuration-section declarations and reads. */
import { describe, expect, it } from 'vitest';
import { defineConfigSection, getConfigSection, loadConfig } from '../../src/index.ts';
import { createRuntime } from '../fixtures/fake-runtime.ts';

describe('typed configuration sections', () => {
  it('selects only declared keys and strips their prefix before parsing', async () => {
    const { z } = await import('zod-v4');
    const database = defineConfigSection({
      prefix: 'DATABASE_',
      keys: ['URL', 'POOL_SIZE'],
      schema: z
        .object({
          URL: z.string().url(),
          POOL_SIZE: z.coerce.number().int().positive(),
        })
        .strict(),
    });

    const config = await loadConfig(
      createRuntime({
        env: {
          DATABASE_URL: 'postgres://localhost/app',
          DATABASE_POOL_SIZE: '4',
          DATABASE_IGNORED: 'not selected',
        },
      }),
      { sections: [database] },
    );

    expect(getConfigSection(config, database)).toEqual({
      URL: 'postgres://localhost/app',
      POOL_SIZE: 4,
    });
  });
});

import {
  createConfigSectionCacheEntry,
  replaceConfigSectionCache,
} from '../../src/sections/config-section.ts';
it('refuses a cache entry associated with a different declaration', async () => {
  const schema = { parse: (input: unknown) => input };
  const first = defineConfigSection({ prefix: 'FIRST_', keys: [], schema });
  const second = defineConfigSection({ prefix: 'SECOND_', keys: [], schema });
  const config = await loadConfig(createRuntime(), { sections: [first] });
  replaceConfigSectionCache(config, new Map([[first, createConfigSectionCacheEntry(second, {})]]));
  expect(() => getConfigSection(config, first)).toThrow('was not validated at startup');
});

it('omits an absent declared key before parsing the section', async () => {
  const definition = defineConfigSection({
    prefix: 'OPTIONAL_',
    keys: ['ABSENT'],
    schema: { parse: (input: unknown) => input },
  });
  const config = await loadConfig(createRuntime(), { sections: [definition] });
  expect(getConfigSection(config, definition)).toEqual({});
});
