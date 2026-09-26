import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IRuntimeServices } from '@setu-ts/common';

import {
  DiagnosticSpanProcessor,
  type ReadableSpanInput,
} from '../../src/diagnostics/diagnostic-span-processor.ts';
import {
  compileTraceDiagnosticsPolicy,
  SpanObservationCollector,
} from '../../src/diagnostics/span-observation-collector.ts';

const TRACE = 'a'.repeat(32);
const SPAN = 'b'.repeat(16);
const PARENT = 'c'.repeat(16);

function harness() {
  const policy = compileTraceDiagnosticsPolicy({
    enabled: true,
    serviceAlias: 'orders',
    operations: { 'POST /orders': 'create-order' },
  });
  const availability = {
    coverage: 'completed-sampled-spans' as const,
    instrumentation: () => [],
    sampler: { kind: 'always-on' as const },
  };
  const collector = new SpanObservationCollector(
    availability,
    { hrtime: () => 0 } as unknown as Pick<IRuntimeServices, 'hrtime'>,
  );
  const processor = new DiagnosticSpanProcessor(policy, collector);
  return { processor, collector };
}

/** A complete readable span carrying a canary in EVERY field the design forbids. */
function readableSpan(overrides: Partial<ReadableSpanInput> = {}): ReadableSpanInput {
  return {
    name: 'POST /orders',
    kind: 1, // @opentelemetry/api SpanKind.SERVER
    spanContext: () => ({ traceId: TRACE, spanId: SPAN, traceFlags: 1, isRemote: false }),
    links: [],
    status: { code: 0 },
    duration: [0, 12_500_000],
    ...overrides,
  };
}

/** Attaches forbidden canary fields without widening the readable input type. */
function withForbiddenData(span: ReadableSpanInput): ReadableSpanInput {
  const hostile = span as unknown as Record<string, unknown>;
  hostile.attributes = { 'http.url': '/secret?token=CANARY' };
  hostile.events = [{ name: 'exception', attributes: { CANARY: 'value' } }];
  hostile.resource = { 'service.name': 'CANARY' };
  hostile.instrumentationScope = { name: 'CANARY' };
  const status = hostile.status as { code: number; message?: string };
  status.message = 'CANARY failure detail';
  const links = hostile.links as unknown[] | undefined;
  if (links !== undefined && links.length > 0) {
    links[0] = {
      context: (links[0] as Record<string, unknown>)?.['context'],
      attributes: { CANARY: 'link-attr' },
    };
  }
  return span;
}

describe('DiagnosticSpanProcessor — lifecycle', () => {
  it('onStart is a synchronous no-op retaining nothing', () => {
    const { processor, collector } = harness();
    processor.onStart(readableSpan(), undefined);
    expect(collector.read('i', 0).records).toEqual([]);
  });

  it('forceFlush resolves without touching the exporter', async () => {
    const { processor } = harness();
    await expect(processor.forceFlush()).resolves.toBeUndefined();
  });

  it('shutdown closes the collector and is idempotent', async () => {
    const { processor, collector } = harness();
    processor.onEnd(readableSpan());
    await processor.shutdown();
    expect(collector.read('i', 0).closed).toBe(true);
    await processor.shutdown();
    expect(collector.read('i', 0).closed).toBe(true);
  });
});

describe('DiagnosticSpanProcessor — minimization', () => {
  it('projects the approved fields and replaces the raw name with its alias', () => {
    const { processor, collector } = harness();
    processor.onEnd(withForbiddenData(readableSpan()));
    const batch = collector.read('i', 0);
    expect(batch.records.length).toBe(1);
    const record = batch.records[0]!;
    expect(record.operationAlias).toBe('create-order');
    expect(record.serviceAlias).toBe('orders');
    expect(record.kind).toBe('server');
    expect(record.outcome).toBe('unset');
    expect(record.durationMs).toBe(12.5);
    // No forbidden field survives anywhere in the retained record.
    const serialized = JSON.stringify(record);
    expect(serialized.includes('CANARY')).toBe(false);
    expect(serialized.includes('POST /orders')).toBe(false);
  });

  it('maps statuses through the fixed table and drops unknown codes', () => {
    const { processor, collector } = harness();
    processor.onEnd(readableSpan({ status: { code: 2 } }));
    expect(collector.read('i', 0).records[0]!.outcome).toBe('error');
    processor.onEnd(readableSpan({ status: { code: 1 } }));
    expect(collector.read('i', 1).records[0]!.outcome).toBe('ok');
    processor.onEnd(readableSpan({ status: { code: 9 } }));
    expect(collector.read('i', 0).records.length).toBe(2);
    expect(collector.read('i', 0).droppedSpans).toBe(1);
  });

  it('maps every @opentelemetry/api SpanKind value, and drops an unmappable kind', () => {
    // The API enum (span_kind.d.ts): INTERNAL=0 SERVER=1 CLIENT=2 PRODUCER=3
    // CONSUMER=4. A default span arrives as 0 (measured against the locked
    // SDK). 5 is the OTLP WIRE value for CONSUMER — never on a readable span —
    // and must drop rather than be mapped.
    const table: ReadonlyArray<readonly [number, string]> = [
      [0, 'internal'],
      [1, 'server'],
      [2, 'client'],
      [3, 'producer'],
      [4, 'consumer'],
    ];
    const { processor, collector } = harness();
    for (const [code] of table) {
      processor.onEnd(readableSpan({ kind: code }));
    }
    expect(collector.read('i', 0).records.map((r) => r.kind)).toEqual(table.map(([, k]) => k));
    for (const unmappable of [5, 9, -1]) {
      const { processor: p2, collector: c2 } = harness();
      p2.onEnd(readableSpan({ kind: unmappable }));
      expect(c2.read('i', 0).records).toEqual([]);
      expect(c2.read('i', 0).droppedSpans).toBe(1);
    }
  });

  it('drops an unapproved span name before reading anything else', () => {
    const { processor, collector } = harness();
    processor.onEnd(readableSpan({ name: 'GET /secret-admin-path' }));
    expect(collector.read('i', 0).records).toEqual([]);
    expect(collector.read('i', 0).droppedSpans).toBe(1);
  });

  it('drops an invalid span context', () => {
    const { processor, collector } = harness();
    processor.onEnd(readableSpan({
      spanContext: () => ({ traceId: '0'.repeat(32), spanId: SPAN }),
    }));
    processor.onEnd(readableSpan({ spanContext: () => ({ traceId: 'zz', spanId: SPAN }) }));
    expect(collector.read('i', 0).droppedSpans).toBe(2);
  });

  it('converts the hrtime duration tuple and drops a malformed one', () => {
    const { processor, collector } = harness();
    processor.onEnd(readableSpan({ duration: [1, 500_000_000] }));
    expect(collector.read('i', 0).records[0]!.durationMs).toBe(1500);
    processor.onEnd(readableSpan({ duration: [-1, 0] }));
    const missing = readableSpan();
    delete (missing as { duration?: unknown }).duration;
    processor.onEnd(missing);
    expect(collector.read('i', 0).droppedSpans).toBe(2);
  });
});

describe('DiagnosticSpanProcessor — parents and links', () => {
  it('reports a root span and a valid unobserved parent', () => {
    const { processor, collector } = harness();
    processor.onEnd(readableSpan());
    processor.onEnd(readableSpan({
      spanContext: () => ({ traceId: TRACE, spanId: SPAN }),
      parentSpanContext: { traceId: TRACE, spanId: PARENT, isRemote: true },
    }));
    const records = collector.read('i', 0).records;
    expect(records[0]!.parentVisibility).toBe('root');
    expect(records[1]!.parentVisibility).toBe('remote-or-unobserved');
    expect(records[1]!.parentSpanId).toBe(PARENT);
  });

  it('reports observed exactly when the collector retains the parent', () => {
    const { processor, collector } = harness();
    processor.onEnd(readableSpan({
      kind: 1,
      spanContext: () => ({ traceId: TRACE, spanId: PARENT }),
    }));
    processor.onEnd(readableSpan({
      spanContext: () => ({ traceId: TRACE, spanId: SPAN }),
      parentSpanContext: { traceId: TRACE, spanId: PARENT },
    }));
    const records = collector.read('i', 0).records;
    expect(records[1]!.parentVisibility).toBe('observed');
    expect(records[1]!.parentSpanId).toBe(PARENT);
  });

  it('reports unknown for an invalid or cross-trace parent', () => {
    const { processor, collector } = harness();
    processor.onEnd(readableSpan({
      spanContext: () => ({ traceId: TRACE, spanId: SPAN }),
      parentSpanContext: { traceId: TRACE, spanId: '0'.repeat(16) },
    }));
    processor.onEnd(readableSpan({
      spanContext: () => ({ traceId: TRACE, spanId: SPAN }),
      parentSpanContext: { traceId: 'f'.repeat(32), spanId: PARENT },
    }));
    const records = collector.read('i', 0).records;
    for (const record of records) {
      expect(record.parentVisibility).toBe('unknown');
      expect(record.parentSpanId).toBeUndefined();
    }
  });

  it('copies valid links, caps at eight, and skips invalid ones', () => {
    const { processor, collector } = harness();
    const links = Array.from({ length: 10 }, (_, index) => ({
      context: {
        traceId: (index + 1).toString(16).padStart(32, '0'),
        spanId: (index + 1).toString(16).padStart(16, '0'),
      },
    }));
    links.push({ context: { traceId: 'bad', spanId: 'bad' } });
    processor.onEnd(readableSpan({ links }));
    const record = collector.read('i', 0).records[0]!;
    expect(record.links.length).toBe(8);
    expect(record.links[0]).toEqual(links[0].context);
  });
});

describe('DiagnosticSpanProcessor — no throw into OTel', () => {
  it('never throws on a hostile span and counts the drop', () => {
    const { processor, collector } = harness();
    processor.onEnd({
      get name(): string {
        throw new Error('hostile getter');
      },
      kind: 2,
      spanContext: () => ({ traceId: TRACE, spanId: SPAN }),
    });
    expect(collector.read('i', 0).droppedSpans).toBe(1);
  });
});
