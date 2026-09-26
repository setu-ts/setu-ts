import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as exports from '../../src/index.ts';
import type { QueueDepthDiagnosticsOptions, QueueDiagnosticsOptions } from '../../src/index.ts';

describe('barrel exports', () => {
  it('exports QueuePlugin', () => {
    expect(exports.QueuePlugin).toBeDefined();
    expect(typeof exports.QueuePlugin).toBe('function');
  });

  it('exports MemoryQueue', () => {
    expect(exports.MemoryQueue).toBeDefined();
    expect(typeof exports.MemoryQueue).toBe('function');
  });

  it('exports RedisQueue', () => {
    expect(exports.RedisQueue).toBeDefined();
    expect(typeof exports.RedisQueue).toBe('function');
  });

  it('exports RabbitMqQueue', () => {
    expect(exports.RabbitMqQueue).toBeDefined();
    expect(typeof exports.RabbitMqQueue).toBe('function');
  });

  it('does NOT export the tracing decorator', () => {
    // M90i ships a signal, not an API. `TracedQueue` is internal exactly as
    // `messaging-plugin`'s `TracedBroker` is, and this pins it: a re-export
    // file is fully covered merely by being loaded, so nothing else would
    // notice the leak (the M56 defect class).
    expect('TracedQueue' in exports).toBe(false);
  });

  it('exports the M98f option types but not the collector internals', () => {
    // Compile-time: both option types are nameable through the barrel.
    const depths: QueueDepthDiagnosticsOptions = {
      intervalMs: 1_000,
      timeoutMs: 1,
      concurrency: 1,
    };
    const options: QueueDiagnosticsOptions = {
      enabled: true,
      instanceAlias: 'a',
      queues: {},
      depths,
    };
    expect(options.depths).toBe(depths);
    for (
      const internal of [
        'QueueObservationCollector',
        'compileQueueDiagnosticsPolicy',
        'createDisabledQueueSource',
      ]
    ) {
      expect(internal in exports).toBe(false);
    }
  });
});
