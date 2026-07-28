import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateJob } from '../../../src/schematics/job.ts';
import { gateOf, options } from './_shared.ts';

describe('job schematic', () => {
  const files = generateJob(deriveNames('order-item'), options());
  const [file] = files;

  it('emits exactly one file', () => {
    expect(files).toHaveLength(1);
  });

  it('emits it at src/jobs/order-item.job.ts', () => {
    expect(file.path).toBe('src/jobs/order-item.job.ts');
  });

  it('produces non-empty contents ending in a newline', () => {
    expect(file.contents.length).toBeGreaterThan(0);
    expect(file.contents.endsWith('\n')).toBe(true);
  });

  it('is ungated', () => {
    expect(gateOf('job')).toBe(undefined);
  });

  it('derives identical output from any casing of the same name', () => {
    const pascal = generateJob(deriveNames('OrderItem'), options());
    expect(pascal).toEqual(files);
  });

  it('declares the job name constant and handler', () => {
    expect(file.contents).toContain("export const ORDER_ITEM_JOB = 'order-item';");
    expect(file.contents).toContain('export async function runOrderItemJob');
  });

  it('declares the payload type the handler accepts', () => {
    expect(file.contents).toContain('export interface OrderItemJobData');
  });
});
