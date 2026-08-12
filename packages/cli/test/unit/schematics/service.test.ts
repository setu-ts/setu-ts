import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { generateService } from '../../../src/schematics/service.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import { options } from './_shared.ts';

describe('service schematic', () => {
  it('emits a plain exported function in functional mode', () => {
    const files = generateService(deriveNames('order-item'), options());

    expect(files).toHaveLength(1);
    expect(files[0].contents).toContain('export function describeOrderItem(): string');
    expect(files[0].contents).not.toContain('@Injectable');
  });

  it('emits an injectable class and barrel in class-based mode', () => {
    const files = generateService(
      deriveNames('order-item'),
      options(['decorator-plugin', 'di-plugin']),
    );

    expect(files.map((file) => file.path)).toEqual([
      'src/services/order-item.service.ts',
      'src/services/index.ts',
    ]);
    expect(files[0].contents).toContain("@Injectable({ token: 'order-item-service' })");
    expect(files[1].contents).toContain('OrderItemService');
  });
});
