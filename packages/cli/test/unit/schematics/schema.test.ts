import { describe, expect, it } from 'vitest';
import { generateSchema } from '../../../src/schematics/schema.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import { options, gateOf } from './_shared.ts';

describe('schema schematic', () => {
  it('requires validation and creates a fresh shared shape', () => {
    expect(gateOf('schema')).toBe('validation-plugin');
    const [file] = generateSchema(deriveNames('price'), options(['validation-plugin']));
    expect(file?.path).toBe('src/shared/schemas/price.schemas.ts');
    expect(file?.contents).toContain("import { z } from 'zod'");
    expect(file?.contents).toContain('export const Price = z.object({})');
    expect(file?.contents).toContain('export type Price = z.infer<typeof Price>');
    expect(file?.managed).toBeUndefined();
  });
  it('places a new subresource shape beside the module shapes', () => {
    const [file] = generateSchema(deriveNames('price'), { ...options(), targetModule: 'invoices' });
    expect(file?.path).toBe('src/modules/invoices/price.schemas.ts');
  });
});
