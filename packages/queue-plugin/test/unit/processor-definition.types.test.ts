import { describe, expect, it } from 'vitest';
import type { IJob } from '@setu-ts/common';
import { QueuePlugin } from '../../src/index.ts';
import type { QueueProcessorDefinition } from '../../src/index.ts';

interface Order {
  orderId: string;
}

const typed: QueueProcessorDefinition<Order> = {
  name: 'order',
  processor(job: IJob<Order>) {
    expect(typeof job.data.orderId).toBe('string');
  },
};
const erased: QueueProcessorDefinition = typed;
const contradicted: QueueProcessorDefinition<Order> = {
  name: 'invalid',
  // @ts-expect-error A processor cannot contradict the declared payload type.
  processor(_job: IJob<{ count: number }>) {},
};

describe('typed processor definitions', () => {
  it('admits typed definitions and inline processors in the plugin list', () => {
    expect(erased).toBe(typed);
    expect(contradicted.name).toBe('invalid');
    expect(
      QueuePlugin({
        processors: [
          typed,
          {
            name: 'inline',
            processor: (_job: IJob<Order>) => {},
          },
        ],
      }).name,
    ).toBe('queue-plugin');
  });
});
