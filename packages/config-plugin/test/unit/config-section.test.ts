/** Tests for typed configuration-section declarations and reads. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { defineConfigSection, getConfigSection, loadConfig } from '../../src/index.ts';
import { createRuntime } from '../fixtures/fake-runtime.ts';

describe('typed configuration sections', () => {
  it('selects only declared keys and strips their prefix before parsing', async () => {
    const { z } = await import('npm:zod@^3.24.0');
    const database = defineConfigSection({
      prefix: 'DATABASE_',
      keys: ['URL', 'POOL_SIZE'],
      schema: z.object({
        URL: z.string().url(),
        POOL_SIZE: z.coerce.number().int().positive(),
      }).strict(),
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
