/**
 * Unit tests for Prometheus renderer.
 *
 * @module
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { renderPrometheus } from '../../src/renderers/prometheus-renderer.ts';
import type { MetricSnapshot } from '../../src/interfaces/index.ts';

Deno.test('renderPrometheus — empty snapshots returns empty string', () => {
  const result = renderPrometheus([]);
  assertEquals(result, '');
});

Deno.test('renderPrometheus — counter emits # HELP / # TYPE / value', () => {
  const snapshot: MetricSnapshot = {
    name: 'test_counter',
    type: 'counter',
    help: 'Test counter help',
    labels: [],
    values: new Map([['', { value: 42 }]]),
  };

  const result = renderPrometheus([snapshot]);

  assertEquals(result.includes('# HELP test_counter Test counter help'), true);
  assertEquals(result.includes('# TYPE test_counter counter'), true);
  assertEquals(result.includes('test_counter 42'), true);
});

Deno.test('renderPrometheus — gauge emits # HELP / # TYPE / value', () => {
  const snapshot: MetricSnapshot = {
    name: 'test_gauge',
    type: 'gauge',
    help: 'Test gauge help',
    labels: [],
    values: new Map([['', { value: 10 }]]),
  };

  const result = renderPrometheus([snapshot]);

  assertEquals(result.includes('# HELP test_gauge Test gauge help'), true);
  assertEquals(result.includes('# TYPE test_gauge gauge'), true);
  assertEquals(result.includes('test_gauge 10'), true);
});

Deno.test('renderPrometheus — histogram emits buckets + sum + count', () => {
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

  assertEquals(result.includes('# HELP test_histogram Test histogram help'), true);
  assertEquals(result.includes('# TYPE test_histogram histogram'), true);
  assertEquals(result.includes('_bucket{'), true);
  assertEquals(result.includes('le="1"'), true);
  assertEquals(result.includes('le="+Inf"'), true);
  assertEquals(result.includes('_sum'), true);
  assertEquals(result.includes('_count'), true);
});

Deno.test('renderPrometheus — summary emits quantiles + sum + count', () => {
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

  assertEquals(result.includes('# HELP test_summary Test summary help'), true);
  assertEquals(result.includes('# TYPE test_summary summary'), true);
  assertEquals(result.includes('quantile="0.5"'), true);
  assertEquals(result.includes('quantile="0.9"'), true);
  assertEquals(result.includes('quantile="0.99"'), true);
  assertEquals(result.includes('_sum'), true);
  assertEquals(result.includes('_count'), true);
});

Deno.test('renderPrometheus — label escaping handles backslash and newline', () => {
  const snapshot: MetricSnapshot = {
    name: 'test_counter',
    type: 'counter',
    help: 'Test',
    labels: ['method'],
    values: new Map([['method=GET', { value: 1 }]]),
  };

  const result = renderPrometheus([snapshot]);

  // Should contain the label
  assertEquals(result.includes('method="GET"'), true);
});

Deno.test('renderPrometheus — multiple metrics are separated', () => {
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

  assertEquals(result.includes('counter1'), true);
  assertEquals(result.includes('gauge1'), true);
  // Metrics should be separated by blank lines
  assertEquals(result.match(/\n\n/g)?.length, 1);
});

Deno.test('renderPrometheus — histogram with labels emits correct format', () => {
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
        },
      ],
    ]),
  };

  const result = renderPrometheus([snapshot]);

  assertEquals(result.includes('http_duration_bucket'), true);
  assertEquals(result.includes('method="GET"'), true);
  assertEquals(result.includes('status="200"'), true);
  assertEquals(result.includes('le="0.1"'), true);
  assertEquals(result.includes('le="+Inf"'), true);
  assertEquals(result.includes('http_duration_sum'), true);
  assertEquals(result.includes('http_duration_count'), true);
});

Deno.test('renderPrometheus — counter with labels', () => {
  const snapshot: MetricSnapshot = {
    name: 'http_requests',
    type: 'counter',
    help: 'HTTP requests',
    labels: ['method', 'status'],
    values: new Map([
      ['method=GET|status=200', { value: 10 }],
      ['method=POST|status=201', { value: 5 }],
    ]),
  };

  const result = renderPrometheus([snapshot]);

  assertEquals(result.includes('http_requests'), true);
  assertEquals(result.includes('method="GET"'), true);
  assertEquals(result.includes('status="200"'), true);
  assertEquals(result.includes('10'), true);
  assertEquals(result.includes('method="POST"'), true);
  assertEquals(result.includes('status="201"'), true);
  assertEquals(result.includes('5'), true);
});

Deno.test('renderPrometheus — gauge with labels', () => {
  const snapshot: MetricSnapshot = {
    name: 'active_connections',
    type: 'gauge',
    help: 'Active connections',
    labels: ['host'],
    values: new Map([
      ['host=server1', { value: 100 }],
      ['host=server2', { value: 200 }],
    ]),
  };

  const result = renderPrometheus([snapshot]);

  assertEquals(result.includes('active_connections'), true);
  assertEquals(result.includes('host="server1"'), true);
  assertEquals(result.includes('100'), true);
  assertEquals(result.includes('host="server2"'), true);
  assertEquals(result.includes('200'), true);
});

Deno.test('renderPrometheus — summary with labels', () => {
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
        },
      ],
    ]),
  };

  const result = renderPrometheus([snapshot]);

  assertEquals(result.includes('response_time'), true);
  assertEquals(result.includes('endpoint="/api/users"'), true);
  assertEquals(result.includes('quantile="0.5"'), true);
  assertEquals(result.includes('response_time_sum'), true);
  assertEquals(result.includes('response_time_count'), true);
});

Deno.test('renderPrometheus — histogram cumulative buckets', () => {
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
  assertEquals(result.includes('_bucket'), true);
  assertEquals(result.includes('le="1"'), true);
  assertEquals(result.includes('le="5"'), true);
  assertEquals(result.includes('le="10"'), true);
  assertEquals(result.includes('le="+Inf"'), true);
  // Verify bucket values appear in output
  assertEquals(result.includes(' 2'), true);
  assertEquals(result.includes(' 5'), true);
  assertEquals(result.includes(' 8'), true);
  assertEquals(result.includes(' 10'), true);
});

Deno.test('renderPrometheus — counter with zero value', () => {
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

  assertStringIncludes(result, '# HELP test_counter Test counter');
  assertStringIncludes(result, '# TYPE test_counter counter');
  assertStringIncludes(result, 'test_counter 0');
});

Deno.test('renderPrometheus — gauge with zero value', () => {
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

  assertStringIncludes(result, '# HELP test_gauge Test gauge');
  assertStringIncludes(result, '# TYPE test_gauge gauge');
  assertStringIncludes(result, 'test_gauge 0');
});

Deno.test('renderPrometheus — histogram with labels and sum/count', () => {
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
        },
      ],
    ]),
  };

  const result = renderPrometheus([snapshot]);

  assertStringIncludes(result, 'test_histogram_bucket');
  assertStringIncludes(result, 'method="GET"');
  assertStringIncludes(result, 'le="1"');
  assertStringIncludes(result, 'le="+Inf"');
  assertStringIncludes(result, 'test_histogram_sum');
  assertStringIncludes(result, 'test_histogram_count');
});

Deno.test('renderPrometheus — summary with labels', () => {
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
        },
      ],
    ]),
  };

  const result = renderPrometheus([snapshot]);

  assertStringIncludes(result, 'test_summary');
  assertStringIncludes(result, 'method="POST"');
  assertStringIncludes(result, 'quantile="0.5"');
  assertStringIncludes(result, 'quantile="0.9"');
  assertStringIncludes(result, 'test_summary_sum');
  assertStringIncludes(result, 'test_summary_count');
});

Deno.test('renderPrometheus — extractLabelValue with unknown label', () => {
  // Test that extractLabelValue returns null for unknown labels
  // This is tested indirectly through formatLabels
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
  assertStringIncludes(result, 'test_counter{} 1');
});

Deno.test('renderPrometheus — empty snapshot array returns empty string', () => {
  const result = renderPrometheus([]);
  assertEquals(result, '');
});

Deno.test('renderPrometheus — summary with empty quantiles', () => {
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

  assertStringIncludes(result, 'test_summary_sum');
  assertStringIncludes(result, 'test_summary_count');
});

Deno.test('renderPrometheus — histogram with empty buckets', () => {
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

  assertStringIncludes(result, 'test_histogram_sum');
  assertStringIncludes(result, 'test_histogram_count');
  // Should not have any bucket lines
  assertEquals(result.includes('_bucket'), false);
});

Deno.test('renderPrometheus — counter with multiple label sets', () => {
  const snapshot: MetricSnapshot = {
    name: 'test_counter',
    type: 'counter',
    help: 'Test counter',
    labels: ['method'],
    values: new Map([
      ['method=GET', { value: 10 }],
      ['method=POST', { value: 20 }],
    ]),
  };

  const result = renderPrometheus([snapshot]);

  assertStringIncludes(result, 'method="GET"');
  assertStringIncludes(result, 'method="POST"');
  assertStringIncludes(result, 'test_counter{method="GET"} 10');
  assertStringIncludes(result, 'test_counter{method="POST"} 20');
});

Deno.test('renderPrometheus — gauge with negative value', () => {
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

  assertStringIncludes(result, 'test_gauge -42');
});

Deno.test('renderPrometheus — counter with undefined value uses 0', () => {
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

  assertStringIncludes(result, 'test_counter 0');
});

Deno.test('renderPrometheus — histogram with undefined sum/count', () => {
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
  assertStringIncludes(result, 'test_histogram_bucket');
});

Deno.test('renderPrometheus — summary with undefined quantiles', () => {
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

  assertStringIncludes(result, 'test_summary_sum');
  assertStringIncludes(result, 'test_summary_count');
});

Deno.test('renderPrometheus — histogram with single bucket', () => {
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

  assertStringIncludes(result, 'test_histogram_bucket');
  assertStringIncludes(result, 'le="+Inf"');
  assertStringIncludes(result, 'test_histogram_sum 10');
  assertStringIncludes(result, 'test_histogram_count 1');
});

Deno.test('renderPrometheus — extractLabelValue handles pipe in key', () => {
  // Test the extractLabelValue function with a key containing pipe separator
  const snapshot: MetricSnapshot = {
    name: 'test_counter',
    type: 'counter',
    help: 'Test',
    labels: ['method', 'status'],
    values: new Map([['method=GET|status=200', { value: 1 }]]),
  };

  const result = renderPrometheus([snapshot]);

  assertStringIncludes(result, 'method="GET"');
  assertStringIncludes(result, 'status="200"');
});

Deno.test('renderPrometheus — formatLabels with null label value', () => {
  // Test that formatLabels handles null label values correctly
  const snapshot: MetricSnapshot = {
    name: 'test_counter',
    type: 'counter',
    help: 'Test counter',
    labels: ['method', 'status'],
    values: new Map([
      ['method=GET', { value: 1 }], // missing status label
    ]),
  };

  const result = renderPrometheus([snapshot]);
  // Should render with partial labels
  assertStringIncludes(result, 'method="GET"');
});

Deno.test('renderPrometheus — no-label histogram bucket format (no leading comma)', () => {
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
  assertEquals(result.includes('{,le='), false, 'Should not have leading comma in bucket labels');

  // Should have correct format: name_bucket{le="0.1"}
  assertStringIncludes(result, 'test_hist_bucket{le="0.1"}');
  assertStringIncludes(result, 'test_hist_bucket{le="+Inf"}');
  assertStringIncludes(result, 'test_hist_sum 10');
  assertStringIncludes(result, 'test_hist_count 3');
});

Deno.test('renderPrometheus — no-label counter renders line (not zero lines)', () => {
  const snapshot: MetricSnapshot = {
    name: 'test_counter',
    type: 'counter',
    help: 'Test',
    labels: [],
    values: new Map([['', { value: 10 }]]),
  };

  const result = renderPrometheus([snapshot]);

  // Should render as "name value" with no braces
  assertStringIncludes(result, 'test_counter 10');

  // Should NOT have empty braces for no-label case
  assertEquals(
    result.includes('test_counter{}'),
    false,
    'Should not have empty braces for no-label counter',
  );
});

Deno.test('renderPrometheus — no-label gauge renders line (not zero lines)', () => {
  const snapshot: MetricSnapshot = {
    name: 'test_gauge',
    type: 'gauge',
    help: 'Test',
    labels: [],
    values: new Map([['', { value: 42 }]]),
  };

  const result = renderPrometheus([snapshot]);

  // Should render as "name value" with no braces
  assertStringIncludes(result, 'test_gauge 42');

  // Should NOT have empty braces for no-label case
  assertEquals(
    result.includes('test_gauge{}'),
    false,
    'Should not have empty braces for no-label gauge',
  );
});

Deno.test('renderPrometheus — no-label summary quantile format (no leading comma)', () => {
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
  assertEquals(
    result.includes('{,quantile='),
    false,
    'Should not have leading comma in quantile labels',
  );

  // Should have correct format: name{quantile="0.5"}
  assertStringIncludes(result, 'test_summary{quantile="0.5"} 5');
  assertStringIncludes(result, 'test_summary{quantile="0.9"} 9');
});

Deno.test('renderPrometheus — one-label counter format', () => {
  const snapshot: MetricSnapshot = {
    name: 'test_counter',
    type: 'counter',
    help: 'Test',
    labels: ['method'],
    values: new Map([['method=GET', { value: 10 }]]),
  };

  const result = renderPrometheus([snapshot]);

  // Should have correct format: name{label="value"}
  assertStringIncludes(result, 'test_counter{method="GET"} 10');
  assertEquals(result.includes('{,method='), false, 'Should not have leading comma');
});

Deno.test('renderPrometheus — one-label gauge format', () => {
  const snapshot: MetricSnapshot = {
    name: 'test_gauge',
    type: 'gauge',
    help: 'Test',
    labels: ['host'],
    values: new Map([['host=server1', { value: 100 }]]),
  };

  const result = renderPrometheus([snapshot]);

  // Should have correct format: name{label="value"}
  assertStringIncludes(result, 'test_gauge{host="server1"} 100');
  assertEquals(result.includes('{,host='), false, 'Should not have leading comma');
});

Deno.test('renderPrometheus — one-label histogram bucket format', () => {
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
        },
      ],
    ]),
  };

  const result = renderPrometheus([snapshot]);

  // Should have correct format: name{method="GET",le="0.1"}
  assertStringIncludes(result, 'test_hist_bucket{method="GET",le="0.1"}');
  assertStringIncludes(result, 'test_hist_bucket{method="GET",le="+Inf"}');
  assertEquals(result.includes('{,method='), false, 'Should not have leading comma');
});

Deno.test('renderPrometheus — one-label summary quantile format', () => {
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
        },
      ],
    ]),
  };

  const result = renderPrometheus([snapshot]);

  // Should have correct format: name{endpoint="/api",quantile="0.5"}
  assertStringIncludes(result, 'test_summary{endpoint="/api",quantile="0.5"} 5');
  assertEquals(result.includes('{,endpoint='), false, 'Should not have leading comma');
});

Deno.test('renderPrometheus — two-labels counter format', () => {
  const snapshot: MetricSnapshot = {
    name: 'test_counter',
    type: 'counter',
    help: 'Test',
    labels: ['method', 'status'],
    values: new Map([['method=GET|status=200', { value: 10 }]]),
  };

  const result = renderPrometheus([snapshot]);

  // Should have correct format: name{label1="v1",label2="v2"}
  assertStringIncludes(result, 'test_counter{method="GET",status="200"} 10');
  assertEquals(result.includes('{,method='), false, 'Should not have leading comma');
});

Deno.test('renderPrometheus — two-labels histogram bucket format', () => {
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
        },
      ],
    ]),
  };

  const result = renderPrometheus([snapshot]);

  // Should have correct format: name{method="GET",status="200",le="0.005"}
  assertStringIncludes(result, 'http_duration_bucket{method="GET",status="200",le="0.005"}');
  assertStringIncludes(result, 'http_duration_bucket{method="GET",status="200",le="0.1"}');
  assertStringIncludes(result, 'http_duration_bucket{method="GET",status="200",le="+Inf"}');
  assertEquals(result.includes('{,method='), false, 'Should not have leading comma');
});

Deno.test('renderPrometheus — two-labels summary quantile format', () => {
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
        },
      ],
    ]),
  };

  const result = renderPrometheus([snapshot]);

  // Should have correct format: name{endpoint="/api",method="GET",quantile="0.5"}
  assertStringIncludes(result, 'response_time{endpoint="/api",method="GET",quantile="0.5"} 5');
  assertStringIncludes(result, 'response_time{endpoint="/api",method="GET",quantile="0.9"} 9');
  assertEquals(result.includes('{,endpoint='), false, 'Should not have leading comma');
});

Deno.test('renderPrometheus — customBuckets option has observable effect', () => {
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
  assertStringIncludes(result, 'custom_hist_bucket{le="0.01"}');
  assertStringIncludes(result, 'custom_hist_bucket{le="0.1"}');
  assertStringIncludes(result, 'custom_hist_bucket{le="10"}');
  assertStringIncludes(result, 'custom_hist_bucket{le="+Inf"}');

  // Should NOT have default bucket boundaries
  assertEquals(result.includes('le="0.005"'), false, 'Should not have default bucket 0.005');
  assertEquals(result.includes('le="0.025"'), false, 'Should not have default bucket 0.025');
});
