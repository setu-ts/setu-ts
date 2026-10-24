import { describe, expect, it, vi } from 'vitest';
import {
  INBOX_INACTIVE_THRESHOLD_NS,
  isLeakedConsumer,
  sweepLeakedConsumers,
} from '../../src/brokers/nats-leaked-consumers.ts';
import type { ILeakedConsumer } from '../../src/brokers/nats-leaked-consumers.ts';

const uuid = '12345678-1234-4123-8123-123456789abc';
const name = `messaging-${uuid}`;
const legacy = { name, config: { durable_name: name } };

describe('legacy NATS consumer sweep', () => {
  it.each<[string, ILeakedConsumer, boolean]>([
    ['legacy durable', legacy, true],
    ['zero threshold', { name, config: { ...legacy.config, inactive_threshold: 0 } }, true],
    [
      'matching metadata',
      { name, config: { ...legacy.config, metadata: { 'setu.queue': name } } },
      true,
    ],
    [
      'inbox',
      {
        name: `rr_2einbox_2e${uuid}`,
        config: {
          durable_name: `rr_2einbox_2e${uuid}`,
          metadata: { 'setu.queue': `rr.inbox.${uuid}` },
        },
      },
      true,
    ],
    ['ephemeral', { name, config: {} }, false],
    ['threshold set', { name, config: { ...legacy.config, inactive_threshold: 1 } }, false],
    [
      'different owner',
      { name, config: { ...legacy.config, metadata: { 'setu.queue': 'user' } } },
      false,
    ],
    ['uppercase uuid', { ...legacy, name: name.toUpperCase() }, false],
    ['malformed uuid', { ...legacy, name: 'messaging-123' }, false],
    ['invalid variant', { ...legacy, name: name.replace('-8123-', '-7123-') }, false],
    ['invalid version', { ...legacy, name: name.replace('-4123-', '-0123-') }, false],
    ['extra suffix', { ...legacy, name: `${name}x` }, false],
    ['ordinary queue', { ...legacy, name: 'orders' }, false],
  ])('%s → %s', (_label, consumer, expected) => {
    expect(isLeakedConsumer(consumer)).toBe(expected);
  });

  it('updates only matches and stops after disconnect', async () => {
    let active = true;
    const update = vi.fn(() => {
      active = false;
      return Promise.resolve();
    });
    const manager = {
      async *list() {
        yield { name: 'orders', config: {} };
        yield legacy;
        yield legacy;
      },
      update,
    };
    const report = vi.fn();
    await sweepLeakedConsumers(manager, 'S', () => active, report);
    expect(update.mock.calls).toEqual([
      ['S', name, { inactive_threshold: INBOX_INACTIVE_THRESHOLD_NS }],
    ]);
    expect(report).not.toHaveBeenCalled();
  });

  it.each(['list', 'update'])('reports one %s failure', async (failure) => {
    const error = new Error(failure);
    const manager = {
      async *list() {
        if (failure === 'list') throw error;
        yield legacy;
        yield legacy;
      },
      update: vi.fn(() => Promise.reject(error)),
    };
    const report = vi.fn();
    await sweepLeakedConsumers(manager, 'S', () => true, report);
    expect(report.mock.calls).toEqual([[error]]);
    expect(manager.update).toHaveBeenCalledTimes(failure === 'list' ? 0 : 1);
  });
});
