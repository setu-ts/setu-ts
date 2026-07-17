/**
 * Unit tests for Histogram.
 *
 * @module
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { Histogram } from '../../src/metrics/histogram.ts';

Deno.test('Histogram — observe(value, labels) increments correct bucket', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [1, 5, 10],
  };
  const histogram = new Histogram('test_histogram', config);

  histogram.observe(0.5);
  histogram.observe(3);
  histogram.observe(7);
  histogram.observe(15);

  const buckets = histogram.getBucketCounts();
  assertEquals(buckets.get(1), 1); // 0.5
  assertEquals(buckets.get(5), 2); // 0.5, 3
  assertEquals(buckets.get(10), 3); // 0.5, 3, 7
  assertEquals(buckets.get(Number.POSITIVE_INFINITY), 4); // all
});

Deno.test('Histogram — _sum and _count are accurate', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [1, 5, 10],
  };
  const histogram = new Histogram('test_histogram', config);

  histogram.observe(1);
  histogram.observe(2);
  histogram.observe(3);

  assertEquals(histogram.getSum(), 6);
  assertEquals(histogram.getCount(), 3);
});

Deno.test('Histogram — explicit and default buckets', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [1, 2, 3],
  };
  const histogram = new Histogram('test_histogram', config);

  assertEquals(histogram.buckets.length, 3);
  assertEquals(histogram.buckets[0], 1);
});

Deno.test('Histogram — buckets are sorted', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [10, 1, 5],
  };
  const histogram = new Histogram('test_histogram', config);

  assertEquals(histogram.buckets[0], 1);
  assertEquals(histogram.buckets[1], 5);
  assertEquals(histogram.buckets[2], 10);
});

Deno.test('Histogram — out-of-range values land in +Inf', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [1, 5],
  };
  const histogram = new Histogram('test_histogram', config);

  histogram.observe(100);

  const buckets = histogram.getBucketCounts();
  assertEquals(buckets.get(1), 0);
  assertEquals(buckets.get(5), 0);
  assertEquals(buckets.get(Number.POSITIVE_INFINITY), 1);
});

Deno.test('Histogram — per label-set tracking', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    labels: ['method'],
    buckets: [1, 5],
  };
  const histogram = new Histogram('test_histogram', config);

  histogram.observe(3, { method: 'GET' });
  histogram.observe(10, { method: 'POST' });

  const getBuckets = histogram.getBucketCounts({ method: 'GET' });
  const postBuckets = histogram.getBucketCounts({ method: 'POST' });

  assertEquals(getBuckets.get(5), 1);
  assertEquals(postBuckets.get(Number.POSITIVE_INFINITY), 1);
});
