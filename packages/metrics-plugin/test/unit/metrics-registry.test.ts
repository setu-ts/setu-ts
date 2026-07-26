/**
 * Unit tests for MetricsRegistry.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
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
    expect(entry?.name).toEqual('test_metric');
    expect(entry?.config.type).toEqual('counter');

    expect(registry.has('test_metric')).toEqual(true);
    expect(registry.has('other')).toEqual(false);
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

    expect(() => registry.insert('test_metric', config2, { name: 'test_metric' })).toThrow(Error);
    expect(() => registry.insert('test_metric', config2, { name: 'test_metric' })).toThrow(
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

    expect(registry.size).toEqual(1);
    expect(registry.get('test_metric')?.instance).toEqual(instance);
  });

  it('entries iterator', () => {
    const registry = new MetricsRegistry();
    const config1: MetricConfig = { type: 'counter', help: 'Test1' };
    const config2: MetricConfig = { type: 'gauge', help: 'Test2' };

    registry.insert('metric1', config1, { name: 'metric1' });
    registry.insert('metric2', config2, { name: 'metric2' });

    const entries = Array.from(registry.entries());
    expect(entries.length).toEqual(2);
  });

  it('names array', () => {
    const registry = new MetricsRegistry();
    const config: MetricConfig = { type: 'counter', help: 'Test' };

    registry.insert('metric1', config, { name: 'metric1' });
    registry.insert('metric2', config, { name: 'metric2' });

    const names = registry.names;
    expect(names.length).toEqual(2);
    expect(names.includes('metric1')).toEqual(true);
    expect(names.includes('metric2')).toEqual(true);
  });

  it('size', () => {
    const registry = new MetricsRegistry();
    const config: MetricConfig = { type: 'counter', help: 'Test' };

    expect(registry.size).toEqual(0);

    registry.insert('metric1', config, { name: 'metric1' });
    expect(registry.size).toEqual(1);

    registry.insert('metric2', config, { name: 'metric2' });
    expect(registry.size).toEqual(2);
  });

  it('clear', () => {
    const registry = new MetricsRegistry();
    const config: MetricConfig = { type: 'counter', help: 'Test' };

    registry.insert('metric1', config, { name: 'metric1' });
    registry.clear();

    expect(registry.size).toEqual(0);
    expect(registry.has('metric1')).toEqual(false);
  });
});
