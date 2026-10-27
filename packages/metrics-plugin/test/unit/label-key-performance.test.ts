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
    // Building a key sorts its pairs once; a cached key is returned unsorted.
    const sort = vi.spyOn(Array.prototype, 'sort');
    try {
      metric.getValue({ label: 'missing' });
      sort.mockClear();
      metric.inc(1, { label: 'missing' });
      expect(sort).toHaveBeenCalledTimes(1);
      sort.mockClear();
      metric.inc(1, { label: 'missing' });
      expect(sort).not.toHaveBeenCalled();
    } finally {
      sort.mockRestore();
    }
  });

  it('treats null labels as unlabeled, as before the cache', () => {
    // `labelKey` once guarded with `!labels`; a JavaScript caller passing null
    // must still land on the unlabeled series instead of throwing.
    const metric = new Counter('nullable', { help: 'test', type: 'counter' });
    const none = null as unknown as Readonly<Record<string, string>>;
    metric.inc(2, none);
    metric.inc(1);
    expect([...metric.values.entries()]).toEqual([['', 3]]);
    expect(metric.getValue(none)).toBe(3);
  });

  it('should key each observation by the label values it read once', () => {
    // Security audit F4: values were read twice, so an accessor returning
    // different values cached one series' key under another series' path.
    const metric = new Counter('flip', { help: 'test', type: 'counter', labels: ['route'] });
    let reads = 0;
    const flipping = Object.defineProperty({}, 'route', {
      enumerable: true,
      get: () => (reads++ % 2 === 0 ? '/a' : '/b'),
    }) as Readonly<Record<string, string>>;
    const keyOf = (route: string) => JSON.stringify([['route', route]]);
    for (let index = 0; index < 4; index++) metric.inc(1, flipping);
    // A plain observation must land in its own series; with a wrongly cached
    // key it lands in the other one, for good.
    for (const route of ['/a', '/b']) {
      const before = new Map(metric.values);
      metric.inc(1, { route });
      expect(metric.values.get(keyOf(route))).toBe((before.get(keyOf(route)) ?? 0) + 1);
      const other = route === '/a' ? '/b' : '/a';
      expect(metric.values.get(keyOf(other))).toBe(before.get(keyOf(other)));
    }
  });

  it('should store the same label values it keyed the series by', () => {
    // CodeRabbit on #513 (the audit's N3): the stored labels were a second
    // read, so a flipping getter exported a series whose labels named another.
    const flipping = () => {
      let reads = 0;
      return Object.defineProperty({}, 'route', {
        enumerable: true,
        get: () => (reads++ % 2 === 0 ? '/a' : '/b'),
      }) as Readonly<Record<string, string>>;
    };
    const counter = new Counter('c', { help: 'test', type: 'counter', labels: ['route'] });
    const gauge = new Gauge('g', { help: 'test', type: 'gauge', labels: ['route'] });
    for (let index = 0; index < 3; index++) {
      counter.inc(1, flipping());
      gauge.set(1, flipping());
      gauge.inc(1, flipping());
      gauge.dec(1, flipping());
    }
    const histogram = new Histogram('h', { help: 'test', type: 'histogram', labels: ['route'] });
    const summary = new Summary('s', { help: 'test', type: 'summary', labels: ['route'] });
    for (let index = 0; index < 3; index++) {
      histogram.observe(1, flipping());
      summary.observe(1, flipping());
    }
    for (const entries of [
      counter.valueEntries,
      gauge.valueEntries,
      histogram.getAllBucketCounts(),
      summary.getAllQuantiles(),
    ]) {
      expect(entries.size).toBeGreaterThan(0);
      for (const [key, entry] of entries) {
        expect(JSON.stringify(Object.entries(entry.labels!).sort())).toBe(key);
      }
    }
  });
});
