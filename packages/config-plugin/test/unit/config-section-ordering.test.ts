/** Tests for the whole-snapshot then section-validation ordering. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { defineConfigSection, getConfigSection, loadConfig } from '../../src/index.ts';
import { createRuntime } from '../fixtures/fake-runtime.ts';

describe('typed configuration sections | validation ordering', () => {
  it('reads whole-snapshot coercions before parsing a section', async () => {
    const { z } = await import('npm:zod@^3.24.0');
    const sectionSchema = z.object({ PORT: z.number().int() });
    const application = defineConfigSection({
      prefix: 'APP_',
      keys: ['PORT'],
      schema: sectionSchema,
    });
    const wholeSnapshot = z.object({ APP_PORT: z.coerce.number().int() });

    const config = await loadConfig(createRuntime({ env: { APP_PORT: '3000' } }), {
      validationSchema: wholeSnapshot,
      sections: [application],
    });

    expect(getConfigSection(config, application)).toEqual({ PORT: 3000 });
    expect(sectionSchema.safeParse({ PORT: '3000' }).success).toBe(false);
  });
});
