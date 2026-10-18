import { describe, expect, it } from 'vitest';
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

  it('names the declarative registration sites, not a plugin register body', () => {
    // A capability resolved inside another plugin's `register` may not exist yet;
    // the queue and scheduler options are the registration sites both plugins own.
    expect(file.contents).toContain('QueuePlugin({');
    expect(file.contents).toContain('name: ORDER_ITEM_JOB,');
    expect(file.contents).toContain(
      'processor: (job) => runOrderItemJob(job.data as OrderItemJobData),',
    );
    expect(file.contents).toContain('SchedulerPlugin({');
    expect(file.contents).toContain("trigger: 'cron',");
    expect(file.contents).not.toContain('natural home');
    expect(file.contents).toContain('`SchedulerPlugin` is unavailable on Cloudflare Workers');
  });
});
