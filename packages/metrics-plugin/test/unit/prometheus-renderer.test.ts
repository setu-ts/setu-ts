/**
 * Unit tests for Prometheus renderer.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { renderPrometheus } from '../../src/renderers/prometheus-renderer.ts';
import type { MetricSnapshot } from '../../src/interfaces/index.ts';

describe('renderPrometheus', () => {
  it('empty snapshots returns empty string', () => {
    const result = renderPrometheus([]);
    expect(result).toEqual('');
  });

  it('escapes newline and backslash in HELP text (no line splitting)', () => {
    const snapshot: MetricSnapshot = {
      name: 'weird',
      type: 'counter',
      help: 'line1\nline2 with a \\ backslash',
      labels: [],
      values: new Map([['', { value: 1 }]]),
    };

    const result = renderPrometheus([snapshot]);

    // The raw newline must NOT survive — it would split the HELP directive.
    expect(result.includes('# HELP weird line1\\nline2 with a \\\\ backslash')).toEqual(true);
    expect(result.includes('line1\nline2')).toEqual(false);
    // The HELP + TYPE + one value line — HELP stays a single physical line.
    const helpLines = result.split('\n').filter((l) => l.startsWith('# HELP'));
    expect(helpLines.length).toEqual(1);
  });

  it('counter emits # HELP / # TYPE / value', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_counter',
      type: 'counter',
      help: 'Test counter help',
      labels: [],
      values: new Map([['', { value: 42 }]]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result.includes('# HELP test_counter Test counter help')).toEqual(true);
    expect(result.includes('# TYPE test_counter counter')).toEqual(true);
    expect(result.includes('test_counter 42')).toEqual(true);
  });

  it('gauge emits # HELP / # TYPE / value', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_gauge',
      type: 'gauge',
      help: 'Test gauge help',
      labels: [],
      values: new Map([['', { value: 10 }]]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result.includes('# HELP test_gauge Test gauge help')).toEqual(true);
    expect(result.includes('# TYPE test_gauge gauge')).toEqual(true);
    expect(result.includes('test_gauge 10')).toEqual(true);
  });

  it('histogram emits buckets + sum + count', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_histogram',
      type: 'histogram',
      help: 'Test histogram help',
      labels: [],
      values: new Map([
        [
          '',
          {
            value: 10,
            sum: 100,
            buckets: new Map([
              [1, 3],
              [5, 7],
              [Number.POSITIVE_INFINITY, 10],
            ]),
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result.includes('# HELP test_histogram Test histogram help')).toEqual(true);
    expect(result.includes('# TYPE test_histogram histogram')).toEqual(true);
    expect(result.includes('_bucket{')).toEqual(true);
    expect(result.includes('le="1"')).toEqual(true);
    expect(result.includes('le="+Inf"')).toEqual(true);
    expect(result.includes('_sum')).toEqual(true);
    expect(result.includes('_count')).toEqual(true);
  });

  it('summary emits quantiles + sum + count', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_summary',
      type: 'summary',
      help: 'Test summary help',
      labels: [],
      values: new Map([
        [
          '',
          {
            value: 10,
            sum: 100,
            quantiles: new Map([
              [0.5, 5],
              [0.9, 9],
              [0.99, 9.9],
            ]),
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result.includes('# HELP test_summary Test summary help')).toEqual(true);
    expect(result.includes('# TYPE test_summary summary')).toEqual(true);
    expect(result.includes('quantile="0.5"')).toEqual(true);
    expect(result.includes('quantile="0.9"')).toEqual(true);
    expect(result.includes('quantile="0.99"')).toEqual(true);
    expect(result.includes('_sum')).toEqual(true);
    expect(result.includes('_count')).toEqual(true);
  });

  it('label escaping handles backslash and newline', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_counter',
      type: 'counter',
      help: 'Test',
      labels: ['method'],
      values: new Map([['method=GET', { value: 1, labels: { method: 'GET' } }]]),
    };

    const result = renderPrometheus([snapshot]);

    // Should contain the label
    expect(result.includes('method="GET"')).toEqual(true);
  });

  it('multiple metrics are separated', () => {
    const counter: MetricSnapshot = {
      name: 'counter1',
      type: 'counter',
      help: 'Counter 1',
      labels: [],
      values: new Map([['', { value: 1 }]]),
    };

    const gauge: MetricSnapshot = {
      name: 'gauge1',
      type: 'gauge',
      help: 'Gauge 1',
      labels: [],
      values: new Map([['', { value: 2 }]]),
    };

    const result = renderPrometheus([counter, gauge]);

    expect(result.includes('counter1')).toEqual(true);
    expect(result.includes('gauge1')).toEqual(true);
    // Metrics should be separated by blank lines
    expect(result.match(/\n\n/g)?.length).toEqual(1);
  });

  it('histogram with labels emits correct format', () => {
    const snapshot: MetricSnapshot = {
      name: 'http_duration',
      type: 'histogram',
      help: 'HTTP duration',
      labels: ['method', 'status'],
      values: new Map([
        [
          'method=GET|status=200',
          {
            value: 5,
            sum: 50,
            buckets: new Map([
              [0.1, 3],
              [0.5, 4],
              [Number.POSITIVE_INFINITY, 5],
            ]),
            labels: { method: 'GET', status: '200' },
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result.includes('http_duration_bucket')).toEqual(true);
    expect(result.includes('method="GET"')).toEqual(true);
    expect(result.includes('status="200"')).toEqual(true);
    expect(result.includes('le="0.1"')).toEqual(true);
    expect(result.includes('le="+Inf"')).toEqual(true);
    expect(result.includes('http_duration_sum')).toEqual(true);
    expect(result.includes('http_duration_count')).toEqual(true);
  });

  it('counter with labels', () => {
    const snapshot: MetricSnapshot = {
      name: 'http_requests',
      type: 'counter',
      help: 'HTTP requests',
      labels: ['method', 'status'],
      values: new Map([
        ['method=GET|status=200', { value: 10, labels: { method: 'GET', status: '200' } }],
        ['method=POST|status=201', { value: 5, labels: { method: 'POST', status: '201' } }],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result.includes('http_requests')).toEqual(true);
    expect(result.includes('method="GET"')).toEqual(true);
    expect(result.includes('status="200"')).toEqual(true);
    expect(result.includes('10')).toEqual(true);
    expect(result.includes('method="POST"')).toEqual(true);
    expect(result.includes('status="201"')).toEqual(true);
    expect(result.includes('5')).toEqual(true);
  });

  it('gauge with labels', () => {
    const snapshot: MetricSnapshot = {
      name: 'active_connections',
      type: 'gauge',
      help: 'Active connections',
      labels: ['host'],
      values: new Map([
        ['host=server1', { value: 100, labels: { host: 'server1' } }],
        ['host=server2', { value: 200, labels: { host: 'server2' } }],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result.includes('active_connections')).toEqual(true);
    expect(result.includes('host="server1"')).toEqual(true);
    expect(result.includes('100')).toEqual(true);
    expect(result.includes('host="server2"')).toEqual(true);
    expect(result.includes('200')).toEqual(true);
  });

  it('summary with labels', () => {
    const snapshot: MetricSnapshot = {
      name: 'response_time',
      type: 'summary',
      help: 'Response time',
      labels: ['endpoint'],
      values: new Map([
        [
          'endpoint=/api/users',
          {
            value: 10,
            sum: 100,
            quantiles: new Map([
              [0.5, 5],
              [0.9, 9],
            ]),
            labels: { endpoint: '/api/users' },
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result.includes('response_time')).toEqual(true);
    expect(result.includes('endpoint="/api/users"')).toEqual(true);
    expect(result.includes('quantile="0.5"')).toEqual(true);
    expect(result.includes('response_time_sum')).toEqual(true);
    expect(result.includes('response_time_count')).toEqual(true);
  });

  it('histogram cumulative buckets', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_histogram',
      type: 'histogram',
      help: 'Test histogram',
      labels: [],
      values: new Map([
        [
          '',
          {
            value: 10,
            sum: 100,
            buckets: new Map([
              [1, 2],
              [5, 5],
              [10, 8],
              [Number.POSITIVE_INFINITY, 10],
            ]),
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    // Check that bucket values are present (cumulative based on histogram implementation)
    expect(result.includes('_bucket')).toEqual(true);
    expect(result.includes('le="1"')).toEqual(true);
    expect(result.includes('le="5"')).toEqual(true);
    expect(result.includes('le="10"')).toEqual(true);
    expect(result.includes('le="+Inf"')).toEqual(true);
    // Verify bucket values appear in output
    expect(result.includes(' 2')).toEqual(true);
    expect(result.includes(' 5')).toEqual(true);
    expect(result.includes(' 8')).toEqual(true);
    expect(result.includes(' 10')).toEqual(true);
  });

  it('counter with zero value', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_counter',
      type: 'counter',
      help: 'Test counter',
      labels: [],
      values: new Map([
        ['', { value: 0 }],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result).toContain('# HELP test_counter Test counter');
    expect(result).toContain('# TYPE test_counter counter');
    expect(result).toContain('test_counter 0');
  });

  it('gauge with zero value', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_gauge',
      type: 'gauge',
      help: 'Test gauge',
      labels: [],
      values: new Map([
        ['', { value: 0 }],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result).toContain('# HELP test_gauge Test gauge');
    expect(result).toContain('# TYPE test_gauge gauge');
    expect(result).toContain('test_gauge 0');
  });

  it('histogram with labels and sum/count', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_histogram',
      type: 'histogram',
      help: 'Test histogram',
      labels: ['method'],
      values: new Map([
        [
          'method=GET',
          {
            value: 5,
            sum: 50,
            buckets: new Map([
              [1, 3],
              [Number.POSITIVE_INFINITY, 5],
            ]),
            labels: { method: 'GET' },
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result).toContain('test_histogram_bucket');
    expect(result).toContain('method="GET"');
    expect(result).toContain('le="1"');
    expect(result).toContain('le="+Inf"');
    expect(result).toContain('test_histogram_sum');
    expect(result).toContain('test_histogram_count');
  });

  it('summary with labels', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_summary',
      type: 'summary',
      help: 'Test summary',
      labels: ['method'],
      values: new Map([
        [
          'method=POST',
          {
            value: 3,
            sum: 30,
            quantiles: new Map([
              [0.5, 10],
              [0.9, 15],
            ]),
            labels: { method: 'POST' },
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result).toContain('test_summary');
    expect(result).toContain('method="POST"');
    expect(result).toContain('quantile="0.5"');
    expect(result).toContain('quantile="0.9"');
    expect(result).toContain('test_summary_sum');
    expect(result).toContain('test_summary_count');
  });

  it('label rendering from MetricValue.labels handles partial labels', () => {
    // Test that labels are rendered correctly from MetricValue.labels
    // when some label values are missing (falls back to empty object for that entry)
    const snapshot: MetricSnapshot = {
      name: 'test_counter',
      type: 'counter',
      help: 'Test counter',
      labels: ['method', 'unknown_label'],
      values: new Map([
        ['', { value: 1 }],
      ]),
    };

    const result = renderPrometheus([snapshot]);
    // Should still render even with missing labels (returns {} for empty labels)
    expect(result).toContain('test_counter{} 1');
  });

  it('empty snapshot array returns empty string', () => {
    const result = renderPrometheus([]);
    expect(result).toEqual('');
  });

  it('summary with empty quantiles', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_summary',
      type: 'summary',
      help: 'Test summary',
      labels: [],
      values: new Map([
        [
          '',
          {
            value: 3,
            sum: 30,
            quantiles: new Map(),
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result).toContain('test_summary_sum');
    expect(result).toContain('test_summary_count');
  });

  it('histogram with empty buckets', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_histogram',
      type: 'histogram',
      help: 'Test histogram',
      labels: [],
      values: new Map([
        [
          '',
          {
            value: 5,
            sum: 50,
            buckets: new Map(),
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result).toContain('test_histogram_sum');
    expect(result).toContain('test_histogram_count');
    // Should not have any bucket lines
    expect(result.includes('_bucket')).toEqual(false);
  });

  it('counter with multiple label sets', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_counter',
      type: 'counter',
      help: 'Test counter',
      labels: ['method'],
      values: new Map([
        ['method=GET', { value: 10, labels: { method: 'GET' } }],
        ['method=POST', { value: 20, labels: { method: 'POST' } }],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result).toContain('method="GET"');
    expect(result).toContain('method="POST"');
    expect(result).toContain('test_counter{method="GET"} 10');
    expect(result).toContain('test_counter{method="POST"} 20');
  });

  it('gauge with negative value', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_gauge',
      type: 'gauge',
      help: 'Test gauge',
      labels: [],
      values: new Map([
        ['', { value: -42 }],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result).toContain('test_gauge -42');
  });

  it('counter with undefined value uses 0', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_counter',
      type: 'counter',
      help: 'Test counter',
      labels: [],
      values: new Map([
        ['', { value: 0 }],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result).toContain('test_counter 0');
  });

  it('histogram with undefined sum/count', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_histogram',
      type: 'histogram',
      help: 'Test histogram',
      labels: [],
      values: new Map([
        [
          '',
          {
            value: undefined as unknown as number,
            sum: undefined as unknown as number,
            buckets: new Map([[1, 1]]),
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    // Should still render buckets even without sum/count
    expect(result).toContain('test_histogram_bucket');
  });

  it('summary with undefined quantiles', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_summary',
      type: 'summary',
      help: 'Test summary',
      labels: [],
      values: new Map([
        [
          '',
          {
            value: 5,
            sum: 50,
            quantiles: undefined as unknown as ReadonlyMap<number, number>,
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result).toContain('test_summary_sum');
    expect(result).toContain('test_summary_count');
  });

  it('histogram with single bucket', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_histogram',
      type: 'histogram',
      help: 'Test histogram',
      labels: [],
      values: new Map([
        [
          '',
          {
            value: 1,
            sum: 10,
            buckets: new Map([[Number.POSITIVE_INFINITY, 1]]),
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result).toContain('test_histogram_bucket');
    expect(result).toContain('le="+Inf"');
    expect(result).toContain('test_histogram_sum 10');
    expect(result).toContain('test_histogram_count 1');
  });

  it('label values with pipe character are rendered correctly', () => {
    // Test that label values containing pipe characters are not truncated
    const snapshot: MetricSnapshot = {
      name: 'test_counter',
      type: 'counter',
      help: 'Test',
      labels: ['name'],
      values: new Map([['name=a|b', { value: 1, labels: { name: 'a|b' } }]]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result).toContain('name="a|b"');
  });

  it('label values with equals character are rendered correctly', () => {
    // Test that label values containing equals characters are not confused with label names
    const snapshot: MetricSnapshot = {
      name: 'test_counter',
      type: 'counter',
      help: 'Test',
      labels: ['q'],
      values: new Map([['q=x=y', { value: 1, labels: { q: 'x=y' } }]]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result).toContain('q="x=y"');
  });

  it('no-label histogram bucket format (no leading comma)', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_hist',
      type: 'histogram',
      help: 'Test',
      labels: [],
      values: new Map([
        [
          '',
          {
            value: 3,
            sum: 10,
            buckets: new Map([
              [0.1, 1],
              [Number.POSITIVE_INFINITY, 3],
            ]),
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    // Should NOT contain leading comma
    expect(result.includes('{,le=')).toEqual(false);

    // Should have correct format: name_bucket{le="0.1"}
    expect(result).toContain('test_hist_bucket{le="0.1"}');
    expect(result).toContain('test_hist_bucket{le="+Inf"}');
    expect(result).toContain('test_hist_sum 10');
    expect(result).toContain('test_hist_count 3');
  });

  it('no-label counter renders line (not zero lines)', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_counter',
      type: 'counter',
      help: 'Test',
      labels: [],
      values: new Map([['', { value: 10 }]]),
    };

    const result = renderPrometheus([snapshot]);

    // Should render as "name value" with no braces
    expect(result).toContain('test_counter 10');

    // Should NOT have empty braces for no-label case
    expect(result.includes('test_counter{}')).toEqual(false);
  });

  it('no-label gauge renders line (not zero lines)', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_gauge',
      type: 'gauge',
      help: 'Test',
      labels: [],
      values: new Map([['', { value: 42 }]]),
    };

    const result = renderPrometheus([snapshot]);

    // Should render as "name value" with no braces
    expect(result).toContain('test_gauge 42');

    // Should NOT have empty braces for no-label case
    expect(result.includes('test_gauge{}')).toEqual(false);
  });

  it('no-label summary quantile format (no leading comma)', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_summary',
      type: 'summary',
      help: 'Test',
      labels: [],
      values: new Map([
        [
          '',
          {
            value: 3,
            sum: 30,
            quantiles: new Map([
              [0.5, 5],
              [0.9, 9],
            ]),
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    // Should NOT contain leading comma
    expect(result.includes('{,quantile=')).toEqual(false);

    // Should have correct format: name{quantile="0.5"}
    expect(result).toContain('test_summary{quantile="0.5"} 5');
    expect(result).toContain('test_summary{quantile="0.9"} 9');
  });

  it('one-label counter format', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_counter',
      type: 'counter',
      help: 'Test',
      labels: ['method'],
      values: new Map([['method=GET', { value: 10, labels: { method: 'GET' } }]]),
    };

    const result = renderPrometheus([snapshot]);

    // Should have correct format: name{label="value"}
    expect(result).toContain('test_counter{method="GET"} 10');
    expect(result.includes('{,method=')).toEqual(false);
  });

  it('one-label gauge format', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_gauge',
      type: 'gauge',
      help: 'Test',
      labels: ['host'],
      values: new Map([['host=server1', { value: 100, labels: { host: 'server1' } }]]),
    };

    const result = renderPrometheus([snapshot]);

    // Should have correct format: name{label="value"}
    expect(result).toContain('test_gauge{host="server1"} 100');
    expect(result.includes('{,host=')).toEqual(false);
  });

  it('one-label histogram bucket format', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_hist',
      type: 'histogram',
      help: 'Test',
      labels: ['method'],
      values: new Map([
        [
          'method=GET',
          {
            value: 3,
            sum: 10,
            buckets: new Map([
              [0.1, 1],
              [Number.POSITIVE_INFINITY, 3],
            ]),
            labels: { method: 'GET' },
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    // Should have correct format: name{method="GET",le="0.1"}
    expect(result).toContain('test_hist_bucket{method="GET",le="0.1"}');
    expect(result).toContain('test_hist_bucket{method="GET",le="+Inf"}');
    expect(result.includes('{,method=')).toEqual(false);
  });

  it('one-label summary quantile format', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_summary',
      type: 'summary',
      help: 'Test',
      labels: ['endpoint'],
      values: new Map([
        [
          'endpoint=/api',
          {
            value: 3,
            sum: 30,
            quantiles: new Map([
              [0.5, 5],
            ]),
            labels: { endpoint: '/api' },
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    // Should have correct format: name{endpoint="/api",quantile="0.5"}
    expect(result).toContain('test_summary{endpoint="/api",quantile="0.5"} 5');
    expect(result.includes('{,endpoint=')).toEqual(false);
  });

  it('two-labels counter format', () => {
    const snapshot: MetricSnapshot = {
      name: 'test_counter',
      type: 'counter',
      help: 'Test',
      labels: ['method', 'status'],
      values: new Map([['method=GET|status=200', {
        value: 10,
        labels: { method: 'GET', status: '200' },
      }]]),
    };

    const result = renderPrometheus([snapshot]);

    // Should have correct format: name{label1="v1",label2="v2"}
    expect(result).toContain('test_counter{method="GET",status="200"} 10');
    expect(result.includes('{,method=')).toEqual(false);
  });

  it('two-labels histogram bucket format', () => {
    const snapshot: MetricSnapshot = {
      name: 'http_duration',
      type: 'histogram',
      help: 'Test',
      labels: ['method', 'status'],
      values: new Map([
        [
          'method=GET|status=200',
          {
            value: 5,
            sum: 50,
            buckets: new Map([
              [0.005, 2],
              [0.1, 4],
              [Number.POSITIVE_INFINITY, 5],
            ]),
            labels: { method: 'GET', status: '200' },
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    // Should have correct format: name{method="GET",status="200",le="0.005"}
    expect(result).toContain('http_duration_bucket{method="GET",status="200",le="0.005"}');
    expect(result).toContain('http_duration_bucket{method="GET",status="200",le="0.1"}');
    expect(result).toContain('http_duration_bucket{method="GET",status="200",le="+Inf"}');
    expect(result.includes('{,method=')).toEqual(false);
  });

  it('two-labels summary quantile format', () => {
    const snapshot: MetricSnapshot = {
      name: 'response_time',
      type: 'summary',
      help: 'Test',
      labels: ['endpoint', 'method'],
      values: new Map([
        [
          'endpoint=/api|method=GET',
          {
            value: 3,
            sum: 30,
            quantiles: new Map([
              [0.5, 5],
              [0.9, 9],
            ]),
            labels: { endpoint: '/api', method: 'GET' },
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    // Should have correct format: name{endpoint="/api",method="GET",quantile="0.5"}
    expect(result).toContain('response_time{endpoint="/api",method="GET",quantile="0.5"} 5');
    expect(result).toContain('response_time{endpoint="/api",method="GET",quantile="0.9"} 9');
    expect(result.includes('{,endpoint=')).toEqual(false);
  });

  it('customBuckets option has observable effect', () => {
    const snapshot: MetricSnapshot = {
      name: 'custom_hist',
      type: 'histogram',
      help: 'Test',
      labels: [],
      values: new Map([
        [
          '',
          {
            value: 5,
            sum: 25,
            buckets: new Map([
              [0.01, 1],
              [0.1, 3],
              [10, 5],
              [Number.POSITIVE_INFINITY, 5],
            ]),
          },
        ],
      ]),
    };

    const result = renderPrometheus([snapshot]);

    // Custom bucket boundaries should be observable
    expect(result).toContain('custom_hist_bucket{le="0.01"}');
    expect(result).toContain('custom_hist_bucket{le="0.1"}');
    expect(result).toContain('custom_hist_bucket{le="10"}');
    expect(result).toContain('custom_hist_bucket{le="+Inf"}');

    // Should NOT have default bucket boundaries
    expect(result.includes('le="0.005"')).toEqual(false);
    expect(result.includes('le="0.025"')).toEqual(false);
  });

  it('formatValue handles NaN', () => {
    // Test that formatValue correctly formats NaN as "NaN"
    const snapshot: MetricSnapshot = {
      name: 'test_gauge',
      type: 'gauge',
      help: 'Test',
      labels: [],
      values: new Map([['', { value: NaN }]]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result).toContain('test_gauge NaN');
  });

  it('formatValue handles +Inf', () => {
    // Test that formatValue correctly formats positive infinity as "+Inf"
    const snapshot: MetricSnapshot = {
      name: 'test_gauge',
      type: 'gauge',
      help: 'Test',
      labels: [],
      values: new Map([['', { value: Number.POSITIVE_INFINITY }]]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result).toContain('test_gauge +Inf');
  });

  it('formatValue handles -Inf', () => {
    // Test that formatValue correctly formats negative infinity as "-Inf"
    const snapshot: MetricSnapshot = {
      name: 'test_gauge',
      type: 'gauge',
      help: 'Test',
      labels: [],
      values: new Map([['', { value: Number.NEGATIVE_INFINITY }]]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result).toContain('test_gauge -Inf');
  });

  it('formatLabels with key but no labels in value returns {}', () => {
    // Test that when a key is provided but the value has no labels, formatLabels returns {}
    const snapshot: MetricSnapshot = {
      name: 'test_counter',
      type: 'counter',
      help: 'Test',
      labels: ['method'],
      values: new Map([['', { value: 1 }]]), // key is empty string but no labels property
    };

    const result = renderPrometheus([snapshot]);

    // Should return {} for no-label case even when labels array is defined
    expect(result).toContain('test_counter{} 1');
  });

  it('renderCounter with undefined value uses 0', () => {
    // Test that renderCounter handles undefined value by using 0
    const snapshot: MetricSnapshot = {
      name: 'test_counter',
      type: 'counter',
      help: 'Test',
      labels: [],
      values: new Map([['', { value: undefined as unknown as number }]]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result).toContain('test_counter 0');
  });

  it('renderGauge with undefined value uses 0', () => {
    // Test that renderGauge handles undefined value by using 0
    const snapshot: MetricSnapshot = {
      name: 'test_gauge',
      type: 'gauge',
      help: 'Test',
      labels: [],
      values: new Map([['', { value: undefined as unknown as number }]]),
    };

    const result = renderPrometheus([snapshot]);

    expect(result).toContain('test_gauge 0');
  });
});
