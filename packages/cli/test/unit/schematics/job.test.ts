import { describe, expect, it } from 'vitest';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateJob } from '../../../src/schematics/job.ts';
import { assertSeamContract, options } from './_shared.ts';

describe('job schematic', () => {
  it('emits a functional queue processor factory and managed barrel with queue installed', () => {
    const files = generateJob(deriveNames('widget'), options(['queue-plugin']));
    expect(files.map((file) => file.path)).toEqual(['src/jobs/widget.job.ts', 'src/jobs/index.ts']);
    expect(files[0]!.contents).toContain(
      'createWidgetJobProcessor(\n  services: IServiceRegistry,\n): QueueProcessorDefinition<WidgetJobData>',
    );
    expect(files[0]!.contents).toContain("WIDGET_JOB = 'widget'");
    expect(files[0]!.contents).toContain('async processor(job)');
    expect(files[1]!.contents).toContain('createWidgetJobProcessor');
    expect(files[1]!.managed).toBe(true);
    assertSeamContract('job', 'widget', ['zebra', 'alpha'], { plugins: ['queue-plugin'] });
  });
  const files = generateJob(deriveNames('order-item'), options());
  const [file] = files;

  it('emits exactly one file', () => {
    expect(files).toHaveLength(1);
  });

  it('emits it at src/jobs/order-item.job.ts', () => {
    expect(file.path).toBe('src/jobs/order-item.job.ts');
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
    expect(file.contents).toContain("} from './src/jobs/order-item.job.ts';");
    expect(file.contents).not.toContain('natural home');
    expect(file.contents).toContain('`SchedulerPlugin` is unavailable on Cloudflare Workers');
  });
});
