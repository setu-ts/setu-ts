import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateCommandHandler } from '../../../src/schematics/command-handler.ts';
import { gateOf, options } from './_shared.ts';

describe('command-handler schematic', () => {
  const files = generateCommandHandler(deriveNames('order-item'), options());
  const [file] = files;

  it('emits exactly one file', () => {
    expect(files).toHaveLength(1);
  });

  it('emits it at src/cqrs/order-item.command-handler.ts', () => {
    expect(file.path).toBe('src/cqrs/order-item.command-handler.ts');
  });

  it('produces non-empty contents ending in a newline', () => {
    expect(file.contents.length).toBeGreaterThan(0);
    expect(file.contents.endsWith('\n')).toBe(true);
  });

  it('is gated on cqrs-plugin', () => {
    expect(gateOf('command-handler')).toBe('cqrs-plugin');
  });

  it('derives identical output from any casing of the same name', () => {
    const pascal = generateCommandHandler(deriveNames('OrderItem'), options());
    expect(pascal).toEqual(files);
  });

  it('declares the command and its handler', () => {
    expect(file.contents).toContain(
      'export interface OrderItemCommand extends CqrsCommand<OrderItemPayload>',
    );
    expect(file.contents).toContain(
      'implements ICommandHandler<OrderItemCommand, OrderItemResult>',
    );
  });

  it('defines every type it references', () => {
    for (const declared of ['OrderItemPayload', 'OrderItemResult']) {
      expect(file.contents).toContain(`export interface ${declared}`);
    }
  });
});
