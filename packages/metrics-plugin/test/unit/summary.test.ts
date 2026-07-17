/**
 * Unit tests for Summary.
 *
 * @module
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
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
