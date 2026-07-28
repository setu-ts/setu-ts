import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateService } from '../../../src/schematics/service.ts';
import { gateOf, options } from './_shared.ts';

describe('service schematic', () => {
  const files = generateService(deriveNames('order-item'), options());
  const [file] = files;

  it('emits exactly one file', () => {
    expect(files).toHaveLength(1);
  });

  it('emits it at src/services/order-item.service.ts', () => {
    expect(file.path).toBe('src/services/order-item.service.ts');
  });

  it('produces non-empty contents ending in a newline', () => {
    expect(file.contents.length).toBeGreaterThan(0);
    expect(file.contents.endsWith('\n')).toBe(true);
  });

  it('is ungated', () => {
    expect(gateOf('service')).toBe(undefined);
  });

  it('derives identical output from any casing of the same name', () => {
    const pascal = generateService(deriveNames('OrderItem'), options());
    expect(pascal).toEqual(files);
  });

  it('declares the service class', () => {
    expect(file.contents).toContain('export class OrderItemService');
  });

  it('needs no framework import', () => {
    expect(file.contents).not.toContain('import');
  });
});
