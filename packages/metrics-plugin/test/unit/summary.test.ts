/**
 * Unit tests for Summary.
 *
 * @module
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { Summary } from '../../src/metrics/summary.ts';

Deno.test('Summary — known sample sets produce expected quantile values', () => {
  const config = {
    type: 'summary' as const,
    help: 'Test summary',
  };
  const summary = new Summary('test_summary', config, [0.5, 0.9, 0.99], 100);

  // Add samples 1-10
  for (let i = 1; i <= 10; i++) {
    summary.observe(i);
  }

  const quantiles = summary.getQuantiles();
  assertEquals(quantiles.has(0.5), true);
  assertEquals(quantiles.has(0.9), true);
  assertEquals(quantiles.has(0.99), true);
});

Deno.test('Summary — window is bounded (maxSamples: 4)', () => {
  const config = {
    type: 'summary' as const,
    help: 'Test summary',
  };
  const summary = new Summary('test_summary', config, [0.5], 4);

  // Add 6 samples but window only keeps 4
  for (let i = 1; i <= 6; i++) {
    summary.observe(i);
  }

  // Should have only 4 samples in the window (3, 4, 5, 6)
  assertEquals(summary.getSampleCount(), 4);
  assertEquals(summary.getCount(), 6); // Total count is still 6
});

Deno.test('Summary — default maxSamples is 512', () => {
  const config = {
    type: 'summary' as const,
    help: 'Test summary',
  };
  const summary = new Summary('test_summary', config);

  // Add 600 samples
  for (let i = 1; i <= 600; i++) {
    summary.observe(i);
  }

  // Should be capped at 512
  assertEquals(summary.getSampleCount(), 512);
});

Deno.test('Summary — _sum and _count are accurate', () => {
  const config = {
    type: 'summary' as const,
    help: 'Test summary',
  };
  const summary = new Summary('test_summary', config);

  summary.observe(1);
  summary.observe(2);
  summary.observe(3);

  assertEquals(summary.getSum(), 6);
  assertEquals(summary.getCount(), 3);
});

Deno.test('Summary — per label-set tracking', () => {
  const config = {
    type: 'summary' as const,
    help: 'Test summary',
    labels: ['method'],
  };
  const summary = new Summary('test_summary', config, [0.5], 100);

  summary.observe(1, { method: 'GET' });
  summary.observe(2, { method: 'GET' });
  summary.observe(10, { method: 'POST' });

  void summary.getQuantiles({ method: 'GET' });
  void summary.getQuantiles({ method: 'POST' });

  assertEquals(summary.getSum({ method: 'GET' }), 3);
  assertEquals(summary.getSum({ method: 'POST' }), 10);
});

Deno.test('Summary — default quantiles are [0.5, 0.9, 0.99]', () => {
  const config = {
    type: 'summary' as const,
    help: 'Test summary',
  };
  const summary = new Summary('test_summary', config);

  assertEquals(summary.quantiles.length, 3);
  assertEquals(summary.quantiles[0], 0.5);
  assertEquals(summary.quantiles[1], 0.9);
  assertEquals(summary.quantiles[2], 0.99);
});

Deno.test('Summary — custom quantiles', () => {
  const config = {
    type: 'summary' as const,
    help: 'Test summary',
  };
  const summary = new Summary('test_summary', config, [0.25, 0.75], 100);

  assertEquals(summary.quantiles.length, 2);
  assertEquals(summary.quantiles[0], 0.25);
  assertEquals(summary.quantiles[1], 0.75);
});

Deno.test('Summary — invalid quantile throws', () => {
  const config = {
    type: 'summary' as const,
    help: 'Test summary',
  };

  try {
    new Summary('test_summary', config, [1.5], 100);
    // Should not reach here
    assertEquals(true, false);
  } catch (e) {
    assertEquals(e instanceof Error, true);
    assertEquals((e as Error).message.includes('invalid quantile'), true);
  }
});

Deno.test('Summary — invalid quantile 0 throws', () => {
  const config = {
    type: 'summary' as const,
    help: 'Test summary',
  };

  try {
    new Summary('test_summary', config, [-0.1], 100);
    assertEquals(true, false);
  } catch (e) {
    assertEquals(e instanceof Error, true);
    assertEquals((e as Error).message.includes('invalid quantile'), true);
  }
});

Deno.test('Summary — getAllQuantiles returns all label sets', () => {
  const config = {
    type: 'summary' as const,
    help: 'Test summary',
    labels: ['method'],
  };
  const summary = new Summary('test_summary', config, [0.5], 100);

  summary.observe(1, { method: 'GET' });
  summary.observe(2, { method: 'GET' });
  summary.observe(10, { method: 'POST' });

  const allData = summary.getAllQuantiles();
  assertEquals(allData.size, 2);

  const getData = allData.get('method=GET');
  const postData = allData.get('method=POST');

  assertEquals(getData?.count, 2);
  assertEquals(getData?.sum, 3);
  assertEquals(postData?.count, 1);
  assertEquals(postData?.sum, 10);
});

Deno.test('Summary — empty quantiles when no samples', () => {
  const config = {
    type: 'summary' as const,
    help: 'Test summary',
  };
  const summary = new Summary('test_summary', config);

  const quantiles = summary.getQuantiles();
  assertEquals(quantiles.size, 0);
});

Deno.test('Summary — getQuantiles returns empty for unknown label set', () => {
  const config = {
    type: 'summary' as const,
    help: 'Test summary',
    labels: ['method'],
  };
  const summary = new Summary('test_summary', config, [0.5], 100);

  summary.observe(1, { method: 'GET' });

  const quantiles = summary.getQuantiles({ method: 'POST' });
  assertEquals(quantiles.size, 0);
});

Deno.test('Summary — getSum returns 0 for unknown label set', () => {
  const config = {
    type: 'summary' as const,
    help: 'Test summary',
    labels: ['method'],
  };
  const summary = new Summary('test_summary', config, [0.5], 100);

  assertEquals(summary.getSum({ method: 'UNKNOWN' }), 0);
});

Deno.test('Summary — getCount returns 0 for unknown label set', () => {
  const config = {
    type: 'summary' as const,
    help: 'Test summary',
    labels: ['method'],
  };
  const summary = new Summary('test_summary', config, [0.5], 100);

  assertEquals(summary.getCount({ method: 'UNKNOWN' }), 0);
});

Deno.test('Summary — getSampleCount returns 0 for unknown label set', () => {
  const config = {
    type: 'summary' as const,
    help: 'Test summary',
    labels: ['method'],
  };
  const summary = new Summary('test_summary', config, [0.5], 100);

  assertEquals(summary.getSampleCount({ method: 'UNKNOWN' }), 0);
});

Deno.test('Summary — getAllQuantiles with multiple label sets', () => {
  const config = {
    type: 'summary' as const,
    help: 'Test summary',
    labels: ['method'],
  };
  const summary = new Summary('test_summary', config, [0.5, 0.9], 100);

  summary.observe(1, { method: 'GET' });
  summary.observe(2, { method: 'GET' });
  summary.observe(3, { method: 'POST' });
  summary.observe(4, { method: 'POST' });
  summary.observe(5, { method: 'POST' });

  const allData = summary.getAllQuantiles();
  assertEquals(allData.size, 2);

  // Key format is "method=GET" (no quotes)
  const getData = allData.get('method=GET');
  assertExists(getData);
  assertEquals(getData.sum, 3);
  assertEquals(getData.count, 2);

  const postData = allData.get('method=POST');
  assertExists(postData);
  assertEquals(postData.sum, 12);
  assertEquals(postData.count, 3);
});

Deno.test('Summary — computeQuantile with single sample', () => {
  const config = {
    type: 'summary' as const,
    help: 'Test summary',
  };
  const summary = new Summary('test_summary', config, [0.5, 0.9, 0.99], 100);

  summary.observe(42);

  const quantiles = summary.getQuantiles();
  assertEquals(quantiles.get(0.5), 42);
  assertEquals(quantiles.get(0.9), 42);
  assertEquals(quantiles.get(0.99), 42);
});

Deno.test('Summary — computeQuantile with two samples uses interpolation', () => {
  const config = {
    type: 'summary' as const,
    help: 'Test summary',
  };
  const summary = new Summary('test_summary', config, [0.5], 100);

  summary.observe(10);
  summary.observe(20);

  const quantiles = summary.getQuantiles();
  // With 2 samples, p50 should interpolate to 15
  assertEquals(quantiles.get(0.5), 15);
});
