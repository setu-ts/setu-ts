import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { generateCommandHandler } from '../../src/schematics/command-handler.ts';
import { generateEventHandler } from '../../src/schematics/event-handler.ts';
import { generateJob } from '../../src/schematics/job.ts';
import { generateQueryHandler } from '../../src/schematics/query-handler.ts';
import { generateWsRoute } from '../../src/schematics/ws-route.ts';
import { INGRESS_SEAM } from '../../src/seams/ingress.ts';
import { deriveNames } from '../../src/utils/names.ts';
import { options } from './schematics/_shared.ts';

describe('class-based ingress schematic arms', () => {
  const cases = [
    {
      generate: generateJob,
      decorator: '@Processor(ORDER_ITEM_JOB)',
      plugin: 'queue-plugin',
    },
    {
      generate: generateEventHandler,
      decorator: '@OnEvent(ORDER_ITEM_EVENT)',
      plugin: 'events-plugin',
    },
    {
      generate: generateWsRoute,
      decorator: "@Gateway('/ws/order-item')",
      plugin: 'websocket-plugin',
    },
    {
      generate: generateCommandHandler,
      decorator: '@CommandHandler(ORDER_ITEM_COMMAND)',
      plugin: 'cqrs-plugin',
    },
    {
      generate: generateQueryHandler,
      decorator: '@QueryHandler(ORDER_ITEM_QUERY)',
      plugin: 'cqrs-plugin',
    },
  ] as const;

  for (const { generate, decorator, plugin } of cases) {
    it(`emits ${decorator} into the ingress seam`, () => {
      const files = generate(deriveNames('order-item'), options(['decorator-plugin', plugin]));
      expect(files.map((file) => file.path)).toEqual([
        'src/ingress/order-item.ingress.ts',
        INGRESS_SEAM.barrel,
      ]);
      expect(files[0]?.contents).toContain(decorator);
      expect(files[0]?.contents).toContain('export class OrderItemIngress');
      expect(files[1]?.managed).toBe(true);
      expect(files[1]?.contents).toContain('OrderItemIngress');
    });
  }

  it('keeps class-based ingress separate from the functional event and CQRS seams', () => {
    const event = generateEventHandler(
      deriveNames('order-item'),
      options(['decorator-plugin', 'events-plugin']),
    );
    const command = generateCommandHandler(
      deriveNames('create-order'),
      options(['decorator-plugin', 'cqrs-plugin']),
    );
    const query = generateQueryHandler(
      deriveNames('find-order'),
      options(['decorator-plugin', 'cqrs-plugin']),
    );

    for (const files of [event, command, query]) {
      expect(files.some((file) => file.path === 'src/events/index.ts')).toBe(false);
      expect(files.some((file) => file.path === 'src/cqrs/index.ts')).toBe(false);
    }
  });

  it('keeps a class-based project without QueuePlugin on the functional job shape', () => {
    const files = generateJob(deriveNames('order-item'), options(['decorator-plugin']));
    expect(files.map((file) => file.path)).toEqual(['src/jobs/order-item.job.ts']);
    expect(files[0]?.contents).toContain('runOrderItemJob');
    expect(files[0]?.contents).not.toContain('@Processor');
  });

  it('renders an idempotent, sorted ingress barrel from scanned artifacts', () => {
    const files = generateEventHandler(
      deriveNames('billing'),
      options(['decorator-plugin', 'events-plugin'], [], { ingress: ['zebra', 'billing'] }),
    );
    const barrel = files.find((file) => file.path === INGRESS_SEAM.barrel)?.contents;
    expect(barrel).toContain('BillingIngress');
    expect(barrel).toContain('ZebraIngress');
    expect(barrel?.indexOf('BillingIngress')).toBeLessThan(barrel?.indexOf('ZebraIngress') ?? 0);
  });
});
