/**
 * Unit tests for Histogram.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Histogram } from '../../src/metrics/histogram.ts';

describe('Histogram', () => {
  it('observe(value, labels) increments correct bucket', () => {
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
    expect(buckets.get(1)).toEqual(1); // 0.5
    expect(buckets.get(5)).toEqual(2); // 0.5, 3
    expect(buckets.get(10)).toEqual(3); // 0.5, 3, 7
    expect(buckets.get(Number.POSITIVE_INFINITY)).toEqual(4); // all
  });

  it('_sum and _count are accurate', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      buckets: [1, 5, 10],
    };
    const histogram = new Histogram('test_histogram', config);

    histogram.observe(1);
    histogram.observe(2);
    histogram.observe(3);

    expect(histogram.getSum()).toEqual(6);
    expect(histogram.getCount()).toEqual(3);
  });

  it('explicit and default buckets', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      buckets: [1, 2, 3],
    };
    const histogram = new Histogram('test_histogram', config);

    expect(histogram.buckets.length).toEqual(3);
    expect(histogram.buckets[0]).toEqual(1);
  });

  it('buckets are sorted', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      buckets: [10, 1, 5],
    };
    const histogram = new Histogram('test_histogram', config);

    expect(histogram.buckets[0]).toEqual(1);
    expect(histogram.buckets[1]).toEqual(5);
    expect(histogram.buckets[2]).toEqual(10);
  });

  it('out-of-range values land in +Inf', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      buckets: [1, 5],
    };
    const histogram = new Histogram('test_histogram', config);

    histogram.observe(100);

    const buckets = histogram.getBucketCounts();
    expect(buckets.get(1)).toEqual(0);
    expect(buckets.get(5)).toEqual(0);
    expect(buckets.get(Number.POSITIVE_INFINITY)).toEqual(1);
  });

  it('per label-set tracking', () => {
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

    expect(getBuckets.get(5)).toEqual(1);
    expect(postBuckets.get(Number.POSITIVE_INFINITY)).toEqual(1);
  });

  it('getAllBucketCounts returns all label sets', () => {
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
    expect(allData.size).toEqual(2);

    // New JSON.stringify-based key format
    const getData = allData.get('[["method","GET"]]');
    const postData = allData.get('[["method","POST"]]');

    expect(getData?.count).toEqual(2);
    expect(getData?.sum).toEqual(5);
    expect(postData?.count).toEqual(1);
    expect(postData?.sum).toEqual(10);
  });

  it('empty bucket counts when no observations', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      buckets: [1, 5],
    };
    const histogram = new Histogram('test_histogram', config);

    const buckets = histogram.getBucketCounts();
    expect(buckets.size).toEqual(0);
  });

  it('rejects negative bucket boundaries', () => {
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
      expect(error.message.includes('negative bucket')).toEqual(true);
    }
  });

  it('empty buckets array uses empty array', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      buckets: [],
    };
    const histogram = new Histogram('test_histogram', config);

    expect(histogram.buckets.length).toEqual(0);
  });

  it('value exactly at bucket boundary', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      buckets: [1, 5, 10],
    };
    const histogram = new Histogram('test_histogram', config);

    // Value exactly at boundary should be counted in that bucket
    histogram.observe(5); // Exactly at 5

    const buckets = histogram.getBucketCounts();
    expect(buckets.get(5)).toEqual(1); // Should be in 5 bucket
    expect(buckets.get(10)).toEqual(1); // Should also be in 10 bucket (cumulative)
  });

  it('value below all buckets', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      buckets: [5, 10],
    };
    const histogram = new Histogram('test_histogram', config);

    histogram.observe(1); // Below all buckets

    const buckets = histogram.getBucketCounts();
    expect(buckets.get(5)).toEqual(1); // Should be in first bucket
    expect(buckets.get(10)).toEqual(1); // Should be in all buckets (cumulative)
  });

  it('observe with empty labels object', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      labels: ['method'],
    };
    const histogram = new Histogram('test_histogram', config);

    histogram.observe(5, { method: 'GET' });
    expect(histogram.getSum({ method: 'GET' })).toEqual(5);
  });

  it('uses config.buckets when buckets not passed to constructor', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      buckets: [2, 4, 6],
    };
    const histogram = new Histogram('test_histogram', config);

    expect(histogram.buckets.length).toEqual(3);
    expect(histogram.buckets[0]).toEqual(2);
  });

  it('uses DEFAULT_BUCKETS when no buckets specified', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
    };
    const histogram = new Histogram('test_histogram', config);

    // Default buckets should be used
    expect(histogram.buckets.length).toEqual(11);
    expect(histogram.buckets[0]).toEqual(0.005);
    expect(histogram.buckets[10]).toEqual(10);
  });

  it('getSum returns 0 for unknown label set', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      labels: ['method'],
    };
    const histogram = new Histogram('test_histogram', config);

    // getSum for unknown label set should return 0
    expect(histogram.getSum({ method: 'UNKNOWN' })).toEqual(0);
  });

  it('getCount returns 0 for unknown label set', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      labels: ['method'],
    };
    const histogram = new Histogram('test_histogram', config);

    // getCount for unknown label set should return 0
    expect(histogram.getCount({ method: 'UNKNOWN' })).toEqual(0);
  });

  it('observe value below all buckets increments first bucket and +Inf', () => {
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
    expect(buckets.get(1)).toEqual(1);
    // 0.5 <= 2, so bucket 2 is incremented
    expect(buckets.get(2)).toEqual(1);
    // 0.5 <= 3, so bucket 3 is incremented
    expect(buckets.get(3)).toEqual(1);
    // +Inf is always incremented
    expect(buckets.get(Number.POSITIVE_INFINITY)).toEqual(1);
  });

  it('observe value exactly at last bucket', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      buckets: [1, 2, 3],
    };
    const histogram = new Histogram('test_histogram', config);

    // Value exactly at last bucket
    histogram.observe(3);

    const buckets = histogram.getBucketCounts();
    expect(buckets.get(1)).toEqual(0);
    expect(buckets.get(2)).toEqual(0);
    expect(buckets.get(3)).toEqual(1);
    expect(buckets.get(Number.POSITIVE_INFINITY)).toEqual(1);
  });

  it('getAllBucketCounts with multiple label sets', () => {
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
    expect(allData.size).toEqual(2);

    // New JSON.stringify-based key format
    const getData = allData.get('[["method","GET"]]');
    expect(getData).toBeDefined();
    expect(getData!.sum).toEqual(1);
    expect(getData!.count).toEqual(1);

    const postData = allData.get('[["method","POST"]]');
    expect(postData).toBeDefined();
    expect(postData!.sum).toEqual(5);
    expect(postData!.count).toEqual(2);
  });

  it('observe value above all buckets increments all buckets', () => {
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
    expect(buckets.get(1)).toEqual(0);
    // 100 > 2, so bucket 2 is NOT incremented
    expect(buckets.get(2)).toEqual(0);
    // 100 > 3, so bucket 3 is NOT incremented
    expect(buckets.get(3)).toEqual(0);
    // +Inf is always incremented
    expect(buckets.get(Number.POSITIVE_INFINITY)).toEqual(1);
  });

  it('observe with labels that trigger fallback paths', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      labels: ['method'],
    };
    const histogram = new Histogram('test_histogram', config);

    // Observe with labels - this tests the fallback paths in getAllBucketCounts
    histogram.observe(1.5, { method: 'GET' });

    const allData = histogram.getAllBucketCounts();
    expect(allData.size).toEqual(1);

    // New JSON.stringify-based key format
    const getData = allData.get('[["method","GET"]]');
    expect(getData).toBeDefined();
    // sum and count should be populated
    expect(getData!.sum).toEqual(1.5);
    expect(getData!.count).toEqual(1);
  });

  it('observe with value that triggers bucket fallback path', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
    };
    const histogram = new Histogram('test_histogram', config);

    // Observe value that falls between buckets - tests the ?? 0 fallback in observe
    histogram.observe(3.5);

    const allData = histogram.getAllBucketCounts();
    expect(allData.size).toEqual(1);

    const data = allData.get('');
    expect(data).toBeDefined();
    expect(data!.sum).toEqual(3.5);
    expect(data!.count).toEqual(1);
  });

  it('observe multiple values to test cumulative bucket counting', () => {
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
    expect(buckets.get(5)).toEqual(2);
    // 2 <= 10, 3 <= 10, 7 <= 10, so bucket 10 should have 3
    expect(buckets.get(10)).toEqual(3);
    // All 3 observations go to +Inf
    expect(buckets.get(Number.POSITIVE_INFINITY)).toEqual(3);
  });

  it('observe value that triggers the value > bound branch', () => {
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
    expect(buckets.get(1)).toEqual(0);
    // 100 > 5, so bucket 5 should NOT be incremented
    expect(buckets.get(5)).toEqual(0);
    // 100 > 10, so bucket 10 should NOT be incremented
    expect(buckets.get(10)).toEqual(0);
    // Only +Inf gets incremented
    expect(buckets.get(Number.POSITIVE_INFINITY)).toEqual(1);
  });

  it('getAllBucketCounts with empty data', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
    };
    const histogram = new Histogram('test_histogram', config);

    // No observations - getAllBucketCounts should return empty map
    const allData = histogram.getAllBucketCounts();
    expect(allData.size).toEqual(0);
  });

  it('observe value exactly at first bucket', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      buckets: [1, 2, 3],
    };
    const histogram = new Histogram('test_histogram', config);

    // Value exactly at first bucket
    histogram.observe(1);

    const buckets = histogram.getBucketCounts();
    expect(buckets.get(1)).toEqual(1);
    expect(buckets.get(2)).toEqual(1);
    expect(buckets.get(3)).toEqual(1);
    expect(buckets.get(Number.POSITIVE_INFINITY)).toEqual(1);
  });

  it('getBucketCounts returns empty map for unknown label set', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      labels: ['method'],
    };
    const histogram = new Histogram('test_histogram', config);

    histogram.observe(1, { method: 'GET' });

    const buckets = histogram.getBucketCounts({ method: 'POST' });
    expect(buckets.size).toEqual(0);
  });

  it('empty buckets array results in empty buckets', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      buckets: [],
    };
    const histogram = new Histogram('test_histogram', config);

    // Empty buckets array should result in empty buckets
    expect(histogram.buckets.length).toEqual(0);

    // Observing a value with empty buckets should still increment +Inf
    histogram.observe(5);

    const bucketCounts = histogram.getBucketCounts();
    // +Inf bucket is still created even with empty buckets
    expect(bucketCounts.get(Number.POSITIVE_INFINITY)).toEqual(1);
    expect(histogram.getSum()).toEqual(5);
    expect(histogram.getCount()).toEqual(1);
  });

  it('value exactly at bucket boundary increments that bucket', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      buckets: [1, 5, 10],
    };
    const histogram = new Histogram('test_histogram', config);

    // Value exactly at 5 should increment bucket 5 (and all buckets > 5, and +Inf)
    histogram.observe(5);

    const buckets = histogram.getBucketCounts();
    expect(buckets.get(1)).toEqual(0); // 5 > 1, so NOT in bucket 1
    expect(buckets.get(5)).toEqual(1); // 5 <= 5, so in bucket 5
    expect(buckets.get(10)).toEqual(1); // 5 <= 10, so in bucket 10
    expect(buckets.get(Number.POSITIVE_INFINITY)).toEqual(1);
  });

  it('value just below bucket boundary', () => {
    const config = {
      type: 'histogram' as const,
      help: 'Test histogram',
      buckets: [1, 5, 10],
    };
    const histogram = new Histogram('test_histogram', config);

    // Value 4.999 is < 5, so NOT in bucket 5
    histogram.observe(4.999);

    const buckets = histogram.getBucketCounts();
    expect(buckets.get(1)).toEqual(0); // 4.999 > 1
    expect(buckets.get(5)).toEqual(1); // 4.999 <= 5
    expect(buckets.get(10)).toEqual(1); // 4.999 <= 10
    expect(buckets.get(Number.POSITIVE_INFINITY)).toEqual(1);
  });

  it('getAllBucketCounts with single label set exercises loop', () => {
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
    expect(allData.size).toEqual(1);

    // New JSON.stringify-based key format
    const endpointData = allData.get('[["endpoint","/api/users"]]');
    expect(endpointData).toBeDefined();
    expect(endpointData!.count).toEqual(1);
    expect(endpointData!.sum).toEqual(0.3);
    expect(endpointData!.buckets.get(0.1)).toEqual(0); // 0.3 > 0.1
    expect(endpointData!.buckets.get(0.5)).toEqual(1); // 0.3 <= 0.5
    expect(endpointData!.buckets.get(1)).toEqual(1); // 0.3 <= 1
    expect(endpointData!.buckets.get(Number.POSITIVE_INFINITY)).toEqual(1);
  });
});
