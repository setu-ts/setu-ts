/**
 * Unit tests for MetricsRegistry.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { MetricsRegistry } from '../../src/registry/metrics-registry.ts';
import type { MetricConfig } from '@hono-enterprise/common';

describe('MetricsRegistry', () => {
  it('insert/get/iterate', () => {
    const registry = new MetricsRegistry();
    const config: MetricConfig = {
      type: 'counter',
      help: 'Test',
    };

    registry.insert('test_metric', config, { name: 'test_metric' });

    const entry = registry.get('test_metric');
    assertEquals(entry?.name, 'test_metric');
    assertEquals(entry?.config.type, 'counter');

    assertEquals(registry.has('test_metric'), true);
    assertEquals(registry.has('other'), false);
  });

  it('duplicate name with conflicting type throws', () => {
    const registry = new MetricsRegistry();
    const config1: MetricConfig = {
      type: 'counter',
      help: 'Test',
    };
    const config2: MetricConfig = {
      type: 'gauge',
      help: 'Test',
    };

    registry.insert('test_metric', config1, { name: 'test_metric' });

    assertThrows(
      () => registry.insert('test_metric', config2, { name: 'test_metric' }),
      Error,
      'already registered with type "counter"',
    );
  });

  it('same name + same type is idempotent', () => {
    const registry = new MetricsRegistry();
    const config: MetricConfig = {
      type: 'counter',
      help: 'Test',
    };
    const instance = { name: 'test_metric' };

    registry.insert('test_metric', config, instance);
    registry.insert('test_metric', config, instance);

    assertEquals(registry.size, 1);
    assertEquals(registry.get('test_metric')?.instance, instance);
  });

  it('entries iterator', () => {
    const registry = new MetricsRegistry();
    const config1: MetricConfig = { type: 'counter', help: 'Test1' };
    const config2: MetricConfig = { type: 'gauge', help: 'Test2' };

    registry.insert('metric1', config1, { name: 'metric1' });
    registry.insert('metric2', config2, { name: 'metric2' });

    const entries = Array.from(registry.entries());
    assertEquals(entries.length, 2);
  });

  it('names array', () => {
    const registry = new MetricsRegistry();
    const config: MetricConfig = { type: 'counter', help: 'Test' };

    registry.insert('metric1', config, { name: 'metric1' });
    registry.insert('metric2', config, { name: 'metric2' });

    const names = registry.names;
    assertEquals(names.length, 2);
    assertEquals(names.includes('metric1'), true);
    assertEquals(names.includes('metric2'), true);
  });

  it('size', () => {
    const registry = new MetricsRegistry();
    const config: MetricConfig = { type: 'counter', help: 'Test' };

    assertEquals(registry.size, 0);

    registry.insert('metric1', config, { name: 'metric1' });
    assertEquals(registry.size, 1);

    registry.insert('metric2', config, { name: 'metric2' });
    assertEquals(registry.size, 2);
  });

  it('clear', () => {
    const registry = new MetricsRegistry();
    const config: MetricConfig = { type: 'counter', help: 'Test' };

    registry.insert('metric1', config, { name: 'metric1' });
    registry.clear();

    assertEquals(registry.size, 0);
    assertEquals(registry.has('metric1'), false);
  });
});
