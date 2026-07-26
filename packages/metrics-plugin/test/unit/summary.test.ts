/**
 * Unit tests for Summary.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Summary } from '../../src/metrics/summary.ts';

describe('Summary', () => {
  it('known sample sets produce expected quantile values', () => {
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
    expect(quantiles.has(0.5)).toEqual(true);
    expect(quantiles.has(0.9)).toEqual(true);
    expect(quantiles.has(0.99)).toEqual(true);
  });

  it('window is bounded (maxSamples: 4)', () => {
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
    expect(summary.getSampleCount()).toEqual(4);
    expect(summary.getCount()).toEqual(6); // Total count is still 6
  });

  it('default maxSamples is 512', () => {
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
    expect(summary.getSampleCount()).toEqual(512);
  });

  it('_sum and _count are accurate', () => {
    const config = {
      type: 'summary' as const,
      help: 'Test summary',
    };
    const summary = new Summary('test_summary', config);

    summary.observe(1);
    summary.observe(2);
    summary.observe(3);

    expect(summary.getSum()).toEqual(6);
    expect(summary.getCount()).toEqual(3);
  });

  it('per label-set tracking', () => {
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

    expect(summary.getSum({ method: 'GET' })).toEqual(3);
    expect(summary.getSum({ method: 'POST' })).toEqual(10);
  });

  it('default quantiles are [0.5, 0.9, 0.99]', () => {
    const config = {
      type: 'summary' as const,
      help: 'Test summary',
    };
    const summary = new Summary('test_summary', config);

    expect(summary.quantiles.length).toEqual(3);
    expect(summary.quantiles[0]).toEqual(0.5);
    expect(summary.quantiles[1]).toEqual(0.9);
    expect(summary.quantiles[2]).toEqual(0.99);
  });

  it('custom quantiles', () => {
    const config = {
      type: 'summary' as const,
      help: 'Test summary',
    };
    const summary = new Summary('test_summary', config, [0.25, 0.75], 100);

    expect(summary.quantiles.length).toEqual(2);
    expect(summary.quantiles[0]).toEqual(0.25);
    expect(summary.quantiles[1]).toEqual(0.75);
  });

  it('invalid quantile throws', () => {
    const config = {
      type: 'summary' as const,
      help: 'Test summary',
    };

    try {
      new Summary('test_summary', config, [1.5], 100);
      // Should not reach here
      expect(true).toEqual(false);
    } catch (e) {
      expect(e instanceof Error).toEqual(true);
      expect((e as Error).message.includes('invalid quantile')).toEqual(true);
    }
  });

  it('invalid quantile 0 throws', () => {
    const config = {
      type: 'summary' as const,
      help: 'Test summary',
    };

    try {
      new Summary('test_summary', config, [-0.1], 100);
      expect(true).toEqual(false);
    } catch (e) {
      expect(e instanceof Error).toEqual(true);
      expect((e as Error).message.includes('invalid quantile')).toEqual(true);
    }
  });

  it('getAllQuantiles returns all label sets', () => {
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
    expect(allData.size).toEqual(2);

    // New JSON.stringify-based key format
    const getData = allData.get('[["method","GET"]]');
    const postData = allData.get('[["method","POST"]]');

    expect(getData?.count).toEqual(2);
    expect(getData?.sum).toEqual(3);
    expect(postData?.count).toEqual(1);
    expect(postData?.sum).toEqual(10);
  });

  it('empty quantiles when no samples', () => {
    const config = {
      type: 'summary' as const,
      help: 'Test summary',
    };
    const summary = new Summary('test_summary', config);

    const quantiles = summary.getQuantiles();
    expect(quantiles.size).toEqual(0);
  });

  it('getQuantiles returns empty for unknown label set', () => {
    const config = {
      type: 'summary' as const,
      help: 'Test summary',
      labels: ['method'],
    };
    const summary = new Summary('test_summary', config, [0.5], 100);

    summary.observe(1, { method: 'GET' });

    const quantiles = summary.getQuantiles({ method: 'POST' });
    expect(quantiles.size).toEqual(0);
  });

  it('getSum returns 0 for unknown label set', () => {
    const config = {
      type: 'summary' as const,
      help: 'Test summary',
      labels: ['method'],
    };
    const summary = new Summary('test_summary', config, [0.5], 100);

    expect(summary.getSum({ method: 'UNKNOWN' })).toEqual(0);
  });

  it('getCount returns 0 for unknown label set', () => {
    const config = {
      type: 'summary' as const,
      help: 'Test summary',
      labels: ['method'],
    };
    const summary = new Summary('test_summary', config, [0.5], 100);

    expect(summary.getCount({ method: 'UNKNOWN' })).toEqual(0);
  });

  it('getSampleCount returns 0 for unknown label set', () => {
    const config = {
      type: 'summary' as const,
      help: 'Test summary',
      labels: ['method'],
    };
    const summary = new Summary('test_summary', config, [0.5], 100);

    expect(summary.getSampleCount({ method: 'UNKNOWN' })).toEqual(0);
  });

  it('getAllQuantiles with multiple label sets', () => {
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
    expect(allData.size).toEqual(2);

    // New JSON.stringify-based key format
    const getData = allData.get('[["method","GET"]]');
    expect(getData).toBeDefined();
    expect(getData!.sum).toEqual(3);
    expect(getData!.count).toEqual(2);

    const postData = allData.get('[["method","POST"]]');
    expect(postData).toBeDefined();
    expect(postData!.sum).toEqual(12);
    expect(postData!.count).toEqual(3);
  });

  it('computeQuantile with single sample', () => {
    const config = {
      type: 'summary' as const,
      help: 'Test summary',
    };
    const summary = new Summary('test_summary', config, [0.5, 0.9, 0.99], 100);

    summary.observe(42);

    const quantiles = summary.getQuantiles();
    expect(quantiles.get(0.5)).toEqual(42);
    expect(quantiles.get(0.9)).toEqual(42);
    expect(quantiles.get(0.99)).toEqual(42);
  });

  it('computeQuantile with two samples uses interpolation', () => {
    const config = {
      type: 'summary' as const,
      help: 'Test summary',
    };
    const summary = new Summary('test_summary', config, [0.5], 100);

    summary.observe(10);
    summary.observe(20);

    const quantiles = summary.getQuantiles();
    // With 2 samples, p50 should interpolate to 15
    expect(quantiles.get(0.5)).toEqual(15);
  });
});
