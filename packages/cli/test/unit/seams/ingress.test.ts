/** Tests for the decorated non-HTTP ingress seam. */

import { describe, expect, it } from 'vitest';

import { INGRESS_SEAM } from '../../../src/seams/ingress.ts';

describe('ingress seam', () => {
  it('derives barrel classes with the same normalization as their imports', () => {
    const barrel = INGRESS_SEAM.renderBarrel({
      ingress: ['my_thing', 'foo--bar'],
    });

    expect(barrel).toContain("import { MyThingIngress } from './my_thing.ingress.ts';");
    expect(barrel).toContain("import { FooBarIngress } from './foo--bar.ingress.ts';");
    expect(barrel).toContain('export const INGRESS_HANDLERS: readonly Constructor[] = [');
    expect(barrel).toContain('[FooBarIngress, MyThingIngress]');
  });
});
