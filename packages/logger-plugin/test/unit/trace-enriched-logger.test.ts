// deno-lint-ignore-file no-console -- the sink under test IS `console.log`:
// ConsoleLogger writes there (AI_GUIDELINES §11.6), so capturing it is how the
// emitted record is read.
/**
 * X34-2 — the log-to-trace bridge, at the decorator level.
 *
 * Driven against the REAL `ConsoleLogger` rather than a hand-written `ILogger`
 * stand-in: both shipped loggers hold `#` private fields, so a decorator that
 * called a detached method rather than through the instance would throw at
 * runtime while a plain-object double kept working (M52c).
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ILogger, ITelemetryService, SpanContext } from '@setu-ts/common';

import { ConsoleLogger } from '../../src/loggers/console-logger.ts';
import { TraceEnrichedLogger } from '../../src/loggers/trace-enriched-logger.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/** A telemetry service reporting a fixed active span. */
function reporting(context: SpanContext | undefined): ITelemetryService {
  return {
    withSpan: <T>(_n: string, fn: (span: never) => Promise<T>) => fn(undefined as never),
    activeSpanContext: () => context,
  };
}

/** A telemetry service that does NOT declare the optional member at all. */
function withoutTheMember(): ITelemetryService {
  return {
    withSpan: <T>(_n: string, fn: (span: never) => Promise<T>) => fn(undefined as never),
  };
}

const SPAN: SpanContext = {
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  traceFlags: '01',
};

/** Captures the JSON lines a real ConsoleLogger writes. */
function captureConsole(): { lines: Record<string, unknown>[]; restore: () => void } {
  const lines: Record<string, unknown>[] = [];
  const real = console.log;
  console.log = (line: unknown) => {
    lines.push(JSON.parse(String(line)) as Record<string, unknown>);
  };
  return {
    lines,
    restore: () => {
      console.log = real;
    },
  };
}

/** A real ConsoleLogger, decorated. */
function subject(telemetry: () => ITelemetryService | undefined): ILogger {
  return new TraceEnrichedLogger(
    new ConsoleLogger(createFakeRuntime().runtime, { level: 'trace' }),
    telemetry,
  );
}

describe('TraceEnrichedLogger', () => {
  it('enriches a record with the active span, under the OTel field names', () => {
    const captured = captureConsole();
    try {
      subject(() => reporting(SPAN)).info('hello', { order: 'o-1' });
    } finally {
      captured.restore();
    }

    const [record] = captured.lines;
    // snake_case deliberately (§3.6): these are read by a log backend, and the
    // OTel log-correlation convention Loki/Elastic key on is snake_case. A
    // camelCase spelling would be internally consistent and would join up
    // nowhere.
    expect(record.trace_id).toBe(SPAN.traceId);
    expect(record.span_id).toBe(SPAN.spanId);
    // The caller's own metadata is untouched.
    expect(record.order).toBe('o-1');
    expect(record.msg).toBe('hello');
    // camelCase spellings are NOT emitted.
    expect(record.traceId).toBeUndefined();
    expect(record.spanId).toBeUndefined();
  });

  it('enriches every level', () => {
    for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const) {
      const captured = captureConsole();
      try {
        subject(() => reporting(SPAN))[level]('m');
      } finally {
        captured.restore();
      }
      expect(captured.lines[0]?.trace_id).toBe(SPAN.traceId);
      expect(captured.lines[0]?.level).toBe(level);
    }
  });

  it('enriches through child(), keeping the child bindings', () => {
    // Load-bearing: `request-logger.ts` builds its per-request logger with
    // `logger.child({ requestId })`, so an undecorated child would strip
    // trace_id from precisely the records X34-2 most wants joined.
    const captured = captureConsole();
    try {
      subject(() => reporting(SPAN)).child({ requestId: 'r-1' }).info('m');
    } finally {
      captured.restore();
    }
    expect(captured.lines[0]?.trace_id).toBe(SPAN.traceId);
    expect(captured.lines[0]?.requestId).toBe('r-1');
  });

  it('returns a decorated child, so the chain survives nesting', () => {
    const logger = subject(() => reporting(SPAN));
    expect(logger.child({ a: 1 })).toBeInstanceOf(TraceEnrichedLogger);
    expect(logger.child({ a: 1 }).child({ b: 2 })).toBeInstanceOf(TraceEnrichedLogger);
  });

  it('enriches nothing when no telemetry capability is registered', () => {
    const captured = captureConsole();
    try {
      subject(() => undefined).info('m', { order: 'o-1' });
    } finally {
      captured.restore();
    }
    expect(captured.lines[0]?.trace_id).toBeUndefined();
    expect(captured.lines[0]?.order).toBe('o-1');
  });

  it('enriches nothing when the service omits the optional member', () => {
    // "This service cannot see an active span" — distinct from "nothing is
    // running", and both correctly enrich nothing rather than emitting empty
    // identifiers that would join the record to no trace.
    const captured = captureConsole();
    try {
      subject(() => withoutTheMember()).info('m');
    } finally {
      captured.restore();
    }
    expect(captured.lines[0]?.trace_id).toBeUndefined();
  });

  it('enriches nothing when no span is active', () => {
    const captured = captureConsole();
    try {
      subject(() => reporting(undefined)).info('m');
    } finally {
      captured.restore();
    }
    expect(captured.lines[0]?.trace_id).toBeUndefined();
  });

  it('still logs when the telemetry LOOKUP throws', () => {
    // A replaceable capability can be anything; the observability read must
    // never turn logging into the fault.
    const captured = captureConsole();
    try {
      new TraceEnrichedLogger(
        new ConsoleLogger(createFakeRuntime().runtime, { level: 'trace' }),
        () => {
          throw new Error('registry exploded');
        },
      ).info('m', { order: 'o-1' });
    } finally {
      captured.restore();
    }
    expect(captured.lines[0]?.msg).toBe('m');
    expect(captured.lines[0]?.order).toBe('o-1');
    expect(captured.lines[0]?.trace_id).toBeUndefined();
  });

  it('still logs when activeSpanContext THROWS', () => {
    const captured = captureConsole();
    try {
      subject(() => ({
        withSpan: <T>(_n: string, fn: (s: never) => Promise<T>) => fn(undefined as never),
        activeSpanContext: () => {
          throw new Error('telemetry exploded');
        },
      })).info('m');
    } finally {
      captured.restore();
    }
    expect(captured.lines[0]?.msg).toBe('m');
    expect(captured.lines[0]?.trace_id).toBeUndefined();
  });

  it("lets a caller's own trace_id win over the decorator's", () => {
    const captured = captureConsole();
    try {
      subject(() => reporting(SPAN)).info('m', { trace_id: 'caller-supplied' });
    } finally {
      captured.restore();
    }
    expect(captured.lines[0]?.trace_id).toBe('caller-supplied');
  });

  it('passes `level` through and exposes the decorated logger', () => {
    const inner = new ConsoleLogger(createFakeRuntime().runtime, { level: 'warn' });
    const decorated = new TraceEnrichedLogger(inner, () => undefined);
    expect(decorated.level).toBe('warn');
    expect(decorated.inner).toBe(inner);
  });

  it("honours the inner logger's level filter", () => {
    const captured = captureConsole();
    try {
      new TraceEnrichedLogger(
        new ConsoleLogger(createFakeRuntime().runtime, { level: 'error' }),
        () => reporting(SPAN),
      ).debug('suppressed');
    } finally {
      captured.restore();
    }
    expect(captured.lines).toHaveLength(0);
  });

  it('reads telemetry at CALL time, never at construction', () => {
    // Structural, not stylistic: TelemetryPlugin declares LOGGER in its own
    // optionalDependencies, so the kernel registers the logger FIRST and
    // telemetry is always absent at construction.
    const holder: { service?: ITelemetryService } = {};
    const logger = subject(() => holder.service);

    const first = captureConsole();
    try {
      logger.info('before');
    } finally {
      first.restore();
    }
    expect(first.lines[0]?.trace_id).toBeUndefined();

    holder.service = reporting(SPAN);
    const second = captureConsole();
    try {
      logger.info('after');
    } finally {
      second.restore();
    }
    expect(second.lines[0]?.trace_id).toBe(SPAN.traceId);
  });
});
