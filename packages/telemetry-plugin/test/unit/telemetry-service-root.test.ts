/**
 * M107 §3.9 — `TelemetryService.withSpan` forwards `SpanOptions.root` to the
 * host.
 *
 * `withSpan` builds the host's options field by field, so a member it does not
 * copy is silently dropped and the host never starts a root span. A recording
 * host is the right double here: what is asserted is exactly the options
 * object the host receives.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { TELEMETRY_CONTEXT_OPAQUE } from '@setu-ts/common';
import { TelemetryService } from '../../src/services/telemetry-service.ts';
import { createFakeTracerHost } from '../fixtures/fake-tracer-host.ts';

/** The options object the host received for the one span started. */
function startSpanOptions(host: ReturnType<typeof createFakeTracerHost>): unknown {
  const calls = host.recordedCalls.filter((call) => call.type === 'startSpan');
  expect(calls.length).toBe(1);
  return calls[0]!.args[1];
}

describe('TelemetryService.withSpan — root', () => {
  it('forwards root: true to the host', async () => {
    const host = createFakeTracerHost();
    const service = new TelemetryService(host);

    await service.withSpan('outbox relay t.v1', () => Promise.resolve('ok'), {
      kind: 'internal',
      root: true,
    });

    expect(startSpanOptions(host)).toEqual({ kind: 0, root: true });
  });

  it('forwards root beside a parentContext, leaving the precedence to the host', async () => {
    const host = createFakeTracerHost();
    const service = new TelemetryService(host);
    const parentContext = {
      _opaque: TELEMETRY_CONTEXT_OPAQUE,
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: '01',
    } as const;

    await service.withSpan('s', () => Promise.resolve(), { parentContext, root: true });

    expect(startSpanOptions(host)).toEqual({ parentContext, root: true });
  });

  it('omits root when the caller did not set it', async () => {
    const host = createFakeTracerHost();
    const service = new TelemetryService(host);

    await service.withSpan('s', () => Promise.resolve(), { kind: 'internal' });

    const options = startSpanOptions(host) as Record<string, unknown>;
    expect(options).toEqual({ kind: 0 });
    expect('root' in options).toBe(false);
  });

  it('omits root when the caller set it to false', async () => {
    const host = createFakeTracerHost();
    const service = new TelemetryService(host);

    await service.withSpan('s', () => Promise.resolve(), { root: false });

    expect('root' in (startSpanOptions(host) as Record<string, unknown>)).toBe(false);
  });
});
