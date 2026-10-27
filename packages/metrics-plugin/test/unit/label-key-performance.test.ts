import { describe, expect, it, vi } from 'vitest';
import { Counter } from '../../src/metrics/counter.ts';
import { Gauge } from '../../src/metrics/gauge.ts';
import { Histogram } from '../../src/metrics/histogram.ts';
import { Summary } from '../../src/metrics/summary.ts';

describe('metric label key cache', () => {
  it('preserves byte-identical keys, reordered names and distinct delimiter-rich label values', () => {
    const metric = new Counter('table', { help: 'test', type: 'counter', labels: ['z', 'a'] });
    for (const value of [
      '|',
      '=',
      '"',
      '\\',
      '日本語😀',
      '',
      'a,b',
      '[x]',
      'constructor',
      '__proto__',
    ]) {
      const labels = { z: value, a: `a${value}` };
      metric.inc(1, labels);
      const key = JSON.stringify(Object.entries(labels).sort());
      expect(metric.values.get(key)).toBe(1);
      expect(metric.getValue({ a: labels.a, z: labels.z })).toBe(1);
    }
    const open = new Counter('open', { help: 'test', type: 'counter' });
    open.inc(2, { other: 'value' });
    expect([...open.values.keys()]).toEqual([JSON.stringify([['other', 'value']])]);
    const entries = vi.spyOn(Object, 'entries');
    try {
      metric.inc(1, { a: 'a|', z: '|' });
      expect(entries).not.toHaveBeenCalled();
    } finally {
      entries.mockRestore();
    }
  });

  for (const metric of [
    () => new Counter('cache', { help: 'test', type: 'counter', labels: ['z', 'a'] }),
    () => new Gauge('cache', { help: 'test', type: 'gauge', labels: ['z', 'a'] }),
    () => new Histogram('cache', { help: 'test', type: 'histogram', labels: ['z', 'a'] }),
    () => new Summary('cache', { help: 'test', type: 'summary', labels: ['z', 'a'] }),
  ]) {
    it(`does not enumerate or sort entries after the first configured ${metric().type} observation`, () => {
      const instance = metric();
      instance.observe(1, { a: '1', z: '2' });
      const entries = vi.spyOn(Object, 'entries');
      const sort = vi.spyOn(Array.prototype, 'sort');
      try {
        for (let index = 0; index < 100; index++) instance.observe(2, { z: '2', a: '1' });
        expect(entries).not.toHaveBeenCalled();
        expect(sort).not.toHaveBeenCalled();
      } finally {
        entries.mockRestore();
        sort.mockRestore();
      }
    });
  }

  it('does not cache unobserved combinations requested by getters', () => {
    const metric = new Counter('cache', { help: 'test', type: 'counter', labels: ['label'] });
    const entries = vi.spyOn(Object, 'entries');
    try {
      metric.getValue({ label: 'missing' });
      entries.mockClear();
      metric.inc(1, { label: 'missing' });
      expect(entries).toHaveBeenCalledTimes(1);
      entries.mockClear();
      metric.inc(1, { label: 'missing' });
      expect(entries).not.toHaveBeenCalled();
    } finally {
      entries.mockRestore();
    }
  });
});
