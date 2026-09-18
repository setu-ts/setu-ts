/** Public barrel contract tests for config-plugin. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IConfig } from '@setu-ts/common';

import { defineConfigSection, getConfigSection } from '../../src/index.ts';
import type { ConfigSection } from '../../src/index.ts';

type IsEqual<Actual, Expected> = (<T>() => T extends Actual ? 1 : 2) extends
  (<T>() => T extends Expected ? 1 : 2) ? true : false;

const configContractHasExactlyFourMembers: IsEqual<
  keyof IConfig,
  'get' | 'getOrThrow' | 'has'
> = true;

describe('config-plugin barrel exports', () => {
  it('exports typed configuration-section definitions and accessors', async () => {
    const { z } = await import('npm:zod@^3.24.0');
    const section: ConfigSection<{ readonly PORT: number }> = defineConfigSection({
      prefix: 'APP_',
      keys: ['PORT'],
      schema: z.object({ PORT: z.number() }),
    });

    expect(defineConfigSection).toBeDefined();
    expect(getConfigSection).toBeDefined();
    expect(section.prefix).toBe('APP_');
    expect(configContractHasExactlyFourMembers).toBe(true);
  });
});
