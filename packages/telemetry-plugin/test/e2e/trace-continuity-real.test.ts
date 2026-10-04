/**
 * Type and runtime proof that the real OTel producer agrees with the shared
 * W3C trace-context codec.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { contextToTraceparent } from '@setu-ts/common';

import { TelemetryService } from '../../src/services/telemetry-service.ts';
import { loadOtelTracerProvider } from '../../src/tracing/tracer.ts';

describe('real OTel trace continuity', () => {
  it('formats the active service span without a cast', async () => {
    const host = await loadOtelTracerProvider({
      serviceName: 'trace-continuity-real-test',
      exporter: 'console',
    });
    const service = new TelemetryService(host);

    try {
      await service.withSpan('active-span', () => {
        const active = service.activeSpanContext();
        if (active === undefined) throw new Error('expected an active span');

        expect(contextToTraceparent(active)).toBe(
          `00-${active.traceId}-${active.spanId}-${active.traceFlags}`,
        );
        return Promise.resolve();
      });
    } finally {
      await host.shutdown();
    }
  });
});
