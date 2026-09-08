/**
 * X34-2 — the read that makes a log line joinable to a span.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ITelemetryService, SpanContext } from '@setu-ts/common';

import { NoopTelemetryService, TelemetryService } from '../../src/services/telemetry-service.ts';
import type { TracerHost } from '../../src/interfaces/index.ts';

/** A tracer host that reports a fixed active span. */
function hostReporting(context: SpanContext | undefined): TracerHost {
  return {
    startSpan: () => ({ end() {}, setAttribute() {}, setStatus() {}, recordException() {} }),
    extractContext: () => ({ _opaque: Symbol.for('he.telemetry.context') } as never),
    injectContext: () => ({}),
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
    activeSpanContext: () => context,
  };
}

/** A tracer host that cannot see the OTel context at all. */
function hostWithoutTheMember(): TracerHost {
  return {
    startSpan: () => ({ end() {}, setAttribute() {}, setStatus() {}, recordException() {} }),
    extractContext: () => ({ _opaque: Symbol.for('he.telemetry.context') } as never),
    injectContext: () => ({}),
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  };
}

const SPAN: SpanContext = {
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  traceFlags: '01',
};

describe('TelemetryService.activeSpanContext', () => {
  it("reports the host's active span", () => {
    expect(new TelemetryService(hostReporting(SPAN)).activeSpanContext()).toEqual(SPAN);
  });

  it('reports undefined when nothing is active', () => {
    expect(new TelemetryService(hostReporting(undefined)).activeSpanContext()).toBeUndefined();
  });

  it('reports undefined when the host cannot see the context', () => {
    // A host with no registered context manager omits the member entirely —
    // "cannot see" rather than "nothing is running". Both collapse to
    // `undefined` HERE because a consumer does the same thing in both cases.
    expect(new TelemetryService(hostWithoutTheMember()).activeSpanContext()).toBeUndefined();
  });

  it('is not declared by NoopTelemetryService', () => {
    // Omitting it is the honest answer for a service that creates no real
    // spans: a declared member returning `undefined` forever would claim a
    // capability it does not have.
    // Typed as the CONTRACT rather than the class: reading the member off the
    // concrete type is a compile error, which is itself the assertion — the
    // class does not declare it — but a compile error cannot be observed by a
    // test run, so the runtime absence is asserted through the interface.
    const noop: ITelemetryService = new NoopTelemetryService();
    expect(noop.activeSpanContext).toBeUndefined();
    expect('activeSpanContext' in noop).toBe(false);
  });

  it('satisfies ITelemetryService with only withSpan implemented', () => {
    // Type-level: the member is optional, so every existing implementor stays
    // source-compatible (the M42 `signal?` precedent).
    const minimal: ITelemetryService = {
      withSpan: <T>(_n: string, fn: (span: never) => Promise<T>) => fn(undefined as never),
    };
    expect(minimal.activeSpanContext).toBeUndefined();
  });
});
