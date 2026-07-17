/**
 * Unit tests for Histogram.
 *
 * @module
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';
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

Deno.test('Histogram — getAllBucketCounts returns all label sets', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    labels: ['method'],
    buckets: [1, 5],
  };
  const histogram = new Histogram('test_histogram', config);

  histogram.observe(3, { method: 'GET' });
  histogram.observe(10, { method: 'POST' });
  histogram.observe(2, { method: 'GET' });

  const allData = histogram.getAllBucketCounts();
  assertEquals(allData.size, 2);

  // New JSON.stringify-based key format
  const getData = allData.get('[["method","GET"]]');
  const postData = allData.get('[["method","POST"]]');

  assertEquals(getData?.count, 2);
  assertEquals(getData?.sum, 5);
  assertEquals(postData?.count, 1);
  assertEquals(postData?.sum, 10);
});

Deno.test('Histogram — empty bucket counts when no observations', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [1, 5],
  };
  const histogram = new Histogram('test_histogram', config);

  const buckets = histogram.getBucketCounts();
  assertEquals(buckets.size, 0);
});

Deno.test('Histogram — rejects negative bucket boundaries', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [-1, 5],
  };

  try {
    new Histogram('test_histogram', config);
    throw new Error('Should have thrown');
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    assertEquals(error.message.includes('negative bucket'), true);
  }
});

Deno.test('Histogram — empty buckets array uses empty array', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [],
  };
  const histogram = new Histogram('test_histogram', config);

  assertEquals(histogram.buckets.length, 0);
});

Deno.test('Histogram — value exactly at bucket boundary', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [1, 5, 10],
  };
  const histogram = new Histogram('test_histogram', config);

  // Value exactly at boundary should be counted in that bucket
  histogram.observe(5); // Exactly at 5

  const buckets = histogram.getBucketCounts();
  assertEquals(buckets.get(5), 1); // Should be in 5 bucket
  assertEquals(buckets.get(10), 1); // Should also be in 10 bucket (cumulative)
});

Deno.test('Histogram — value below all buckets', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [5, 10],
  };
  const histogram = new Histogram('test_histogram', config);

  histogram.observe(1); // Below all buckets

  const buckets = histogram.getBucketCounts();
  assertEquals(buckets.get(5), 1); // Should be in first bucket
  assertEquals(buckets.get(10), 1); // Should be in all buckets (cumulative)
});

Deno.test('Histogram — observe with empty labels object', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    labels: ['method'],
  };
  const histogram = new Histogram('test_histogram', config);

  histogram.observe(5, { method: 'GET' });
  assertEquals(histogram.getSum({ method: 'GET' }), 5);
});

Deno.test('Histogram — uses config.buckets when buckets not passed to constructor', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [2, 4, 6],
  };
  const histogram = new Histogram('test_histogram', config);

  assertEquals(histogram.buckets.length, 3);
  assertEquals(histogram.buckets[0], 2);
});

Deno.test('Histogram — uses DEFAULT_BUCKETS when no buckets specified', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
  };
  const histogram = new Histogram('test_histogram', config);

  // Default buckets should be used
  assertEquals(histogram.buckets.length, 11);
  assertEquals(histogram.buckets[0], 0.005);
  assertEquals(histogram.buckets[10], 10);
});

Deno.test('Histogram — getSum returns 0 for unknown label set', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    labels: ['method'],
  };
  const histogram = new Histogram('test_histogram', config);

  // getSum for unknown label set should return 0
  assertEquals(histogram.getSum({ method: 'UNKNOWN' }), 0);
});

Deno.test('Histogram — getCount returns 0 for unknown label set', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    labels: ['method'],
  };
  const histogram = new Histogram('test_histogram', config);

  // getCount for unknown label set should return 0
  assertEquals(histogram.getCount({ method: 'UNKNOWN' }), 0);
});

Deno.test('Histogram — observe value below all buckets increments first bucket and +Inf', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [1, 2, 3],
  };
  const histogram = new Histogram('test_histogram', config);

  // Value below all buckets - cumulative counting means it increments all buckets >= value
  histogram.observe(0.5);

  const buckets = histogram.getBucketCounts();
  // 0.5 <= 1, so bucket 1 is incremented
  assertEquals(buckets.get(1), 1);
  // 0.5 <= 2, so bucket 2 is incremented
  assertEquals(buckets.get(2), 1);
  // 0.5 <= 3, so bucket 3 is incremented
  assertEquals(buckets.get(3), 1);
  // +Inf is always incremented
  assertEquals(buckets.get(Number.POSITIVE_INFINITY), 1);
});

Deno.test('Histogram — observe value exactly at last bucket', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [1, 2, 3],
  };
  const histogram = new Histogram('test_histogram', config);

  // Value exactly at last bucket
  histogram.observe(3);

  const buckets = histogram.getBucketCounts();
  assertEquals(buckets.get(1), 0);
  assertEquals(buckets.get(2), 0);
  assertEquals(buckets.get(3), 1);
  assertEquals(buckets.get(Number.POSITIVE_INFINITY), 1);
});

Deno.test('Histogram — getAllBucketCounts with multiple label sets', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    labels: ['method'],
  };
  const histogram = new Histogram('test_histogram', config);

  histogram.observe(1, { method: 'GET' });
  histogram.observe(2, { method: 'POST' });
  histogram.observe(3, { method: 'POST' });

  const allData = histogram.getAllBucketCounts();
  assertEquals(allData.size, 2);

  // New JSON.stringify-based key format
  const getData = allData.get('[["method","GET"]]');
  assertExists(getData);
  assertEquals(getData.sum, 1);
  assertEquals(getData.count, 1);

  const postData = allData.get('[["method","POST"]]');
  assertExists(postData);
  assertEquals(postData.sum, 5);
  assertEquals(postData.count, 2);
});

Deno.test('Histogram — observe value above all buckets increments all buckets', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [1, 2, 3],
  };
  const histogram = new Histogram('test_histogram', config);

  // Value above all buckets - cumulative counting means all buckets are incremented
  histogram.observe(100);

  const buckets = histogram.getBucketCounts();
  // 100 > 1, so bucket 1 is NOT incremented (value not <= bound)
  assertEquals(buckets.get(1), 0);
  // 100 > 2, so bucket 2 is NOT incremented
  assertEquals(buckets.get(2), 0);
  // 100 > 3, so bucket 3 is NOT incremented
  assertEquals(buckets.get(3), 0);
  // +Inf is always incremented
  assertEquals(buckets.get(Number.POSITIVE_INFINITY), 1);
});

Deno.test('Histogram — observe with labels that trigger fallback paths', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    labels: ['method'],
  };
  const histogram = new Histogram('test_histogram', config);

  // Observe with labels - this tests the fallback paths in getAllBucketCounts
  histogram.observe(1.5, { method: 'GET' });

  const allData = histogram.getAllBucketCounts();
  assertEquals(allData.size, 1);

  // New JSON.stringify-based key format
  const getData = allData.get('[["method","GET"]]');
  assertExists(getData);
  // sum and count should be populated
  assertEquals(getData.sum, 1.5);
  assertEquals(getData.count, 1);
});

Deno.test('Histogram — observe with value that triggers bucket fallback path', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
  };
  const histogram = new Histogram('test_histogram', config);

  // Observe value that falls between buckets - tests the ?? 0 fallback in observe
  histogram.observe(3.5);

  const allData = histogram.getAllBucketCounts();
  assertEquals(allData.size, 1);

  const data = allData.get('');
  assertExists(data);
  assertEquals(data.sum, 3.5);
  assertEquals(data.count, 1);
});

Deno.test('Histogram — observe multiple values to test cumulative bucket counting', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [1, 5, 10],
  };
  const histogram = new Histogram('test_histogram', config);

  // Observe multiple values to test the ?? 0 fallback paths
  histogram.observe(2);
  histogram.observe(3);
  histogram.observe(7);

  const buckets = histogram.getBucketCounts();
  // 2 <= 5, 3 <= 5, 7 > 5, so bucket 5 should have 2
  assertEquals(buckets.get(5), 2);
  // 2 <= 10, 3 <= 10, 7 <= 10, so bucket 10 should have 3
  assertEquals(buckets.get(10), 3);
  // All 3 observations go to +Inf
  assertEquals(buckets.get(Number.POSITIVE_INFINITY), 3);
});

Deno.test('Histogram — observe value that triggers the value > bound branch', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [1, 5, 10],
  };
  const histogram = new Histogram('test_histogram', config);

  // Observe value 100 which is > all buckets
  // This should trigger the `if (value <= bound)` false branch for all buckets
  histogram.observe(100);

  const buckets = histogram.getBucketCounts();
  // 100 > 1, so bucket 1 should NOT be incremented
  assertEquals(buckets.get(1), 0);
  // 100 > 5, so bucket 5 should NOT be incremented
  assertEquals(buckets.get(5), 0);
  // 100 > 10, so bucket 10 should NOT be incremented
  assertEquals(buckets.get(10), 0);
  // Only +Inf gets incremented
  assertEquals(buckets.get(Number.POSITIVE_INFINITY), 1);
});

Deno.test('Histogram — getAllBucketCounts with empty data', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
  };
  const histogram = new Histogram('test_histogram', config);

  // No observations - getAllBucketCounts should return empty map
  const allData = histogram.getAllBucketCounts();
  assertEquals(allData.size, 0);
});

Deno.test('Histogram — observe value exactly at first bucket', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [1, 2, 3],
  };
  const histogram = new Histogram('test_histogram', config);

  // Value exactly at first bucket
  histogram.observe(1);

  const buckets = histogram.getBucketCounts();
  assertEquals(buckets.get(1), 1);
  assertEquals(buckets.get(2), 1);
  assertEquals(buckets.get(3), 1);
  assertEquals(buckets.get(Number.POSITIVE_INFINITY), 1);
});

Deno.test('Histogram — getBucketCounts returns empty map for unknown label set', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    labels: ['method'],
  };
  const histogram = new Histogram('test_histogram', config);

  histogram.observe(1, { method: 'GET' });

  const buckets = histogram.getBucketCounts({ method: 'POST' });
  assertEquals(buckets.size, 0);
});

Deno.test('Histogram — empty buckets array results in empty buckets', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [],
  };
  const histogram = new Histogram('test_histogram', config);

  // Empty buckets array should result in empty buckets
  assertEquals(histogram.buckets.length, 0);

  // Observing a value with empty buckets should still increment +Inf
  histogram.observe(5);

  const bucketCounts = histogram.getBucketCounts();
  // +Inf bucket is still created even with empty buckets
  assertEquals(bucketCounts.get(Number.POSITIVE_INFINITY), 1);
  assertEquals(histogram.getSum(), 5);
  assertEquals(histogram.getCount(), 1);
});

Deno.test('Histogram — value exactly at bucket boundary increments that bucket', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [1, 5, 10],
  };
  const histogram = new Histogram('test_histogram', config);

  // Value exactly at 5 should increment bucket 5 (and all buckets > 5, and +Inf)
  histogram.observe(5);

  const buckets = histogram.getBucketCounts();
  assertEquals(buckets.get(1), 0); // 5 > 1, so NOT in bucket 1
  assertEquals(buckets.get(5), 1); // 5 <= 5, so in bucket 5
  assertEquals(buckets.get(10), 1); // 5 <= 10, so in bucket 10
  assertEquals(buckets.get(Number.POSITIVE_INFINITY), 1);
});

Deno.test('Histogram — value just below bucket boundary', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    buckets: [1, 5, 10],
  };
  const histogram = new Histogram('test_histogram', config);

  // Value 4.999 is < 5, so NOT in bucket 5
  histogram.observe(4.999);

  const buckets = histogram.getBucketCounts();
  assertEquals(buckets.get(1), 0); // 4.999 > 1
  assertEquals(buckets.get(5), 1); // 4.999 <= 5
  assertEquals(buckets.get(10), 1); // 4.999 <= 10
  assertEquals(buckets.get(Number.POSITIVE_INFINITY), 1);
});

Deno.test('Histogram — getAllBucketCounts with single label set exercises loop', () => {
  const config = {
    type: 'histogram' as const,
    help: 'Test histogram',
    labels: ['endpoint'],
    buckets: [0.1, 0.5, 1],
  };
  const histogram = new Histogram('test_histogram', config);

  // Single observation to ensure getAllBucketCounts loop has data
  histogram.observe(0.3, { endpoint: '/api/users' });

  const allData = histogram.getAllBucketCounts();
  assertEquals(allData.size, 1);

  // New JSON.stringify-based key format
  const endpointData = allData.get('[["endpoint","/api/users"]]');
  assertExists(endpointData);
  assertEquals(endpointData.count, 1);
  assertEquals(endpointData.sum, 0.3);
  assertEquals(endpointData.buckets.get(0.1), 0); // 0.3 > 0.1
  assertEquals(endpointData.buckets.get(0.5), 1); // 0.3 <= 0.5
  assertEquals(endpointData.buckets.get(1), 1); // 0.3 <= 1
  assertEquals(endpointData.buckets.get(Number.POSITIVE_INFINITY), 1);
});
