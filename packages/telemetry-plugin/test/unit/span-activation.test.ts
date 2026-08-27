import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { TelemetryService } from '../../src/services/telemetry-service.ts';
import { createFakeTracerHost } from '../fixtures/fake-tracer-host.ts';

describe('TelemetryService span activation', () => {
  it('activates the span and preserves error handling around the activated callback', async () => {
    const host = createFakeTracerHost();
    let active = false;
    host.activate = async (_span, fn) => {
      active = true;
      return await fn();
    };
    const service = new TelemetryService(host);

    await expect(service.withSpan('active', () => {
      expect(active).toBe(true);
      return Promise.reject(new Error('inside active span'));
    })).rejects.toThrow('inside active span');

    expect(host.recordedSpans[0]).toMatchObject({
      name: 'active',
      status: 'error',
      ended: true,
    });
  });

  it('still executes when a host has no activation seam', async () => {
    const service = new TelemetryService(createFakeTracerHost());
    await expect(service.withSpan('inactive-host', () => Promise.resolve('ok'))).resolves.toBe(
      'ok',
    );
  });

  it('hands activate the RAW span the host returned, not the framework wrapper', async () => {
    // `activate` feeds the span to OTel's `trace.setSpan`, which needs the real
    // OTel span object. Passing `OtelSpan` (the framework wrapper) instead would
    // type-check, run without error, and silently parent nothing — the failure
    // mode no assertion on span names could catch.
    const host = createFakeTracerHost();
    let returned: unknown = null;
    let activated: unknown = null;
    const realStartSpan = host.startSpan.bind(host);
    host.startSpan = (name, options) => {
      returned = realStartSpan(name, options);
      return returned;
    };
    host.activate = async (span, fn) => {
      activated = span;
      return await fn();
    };

    await new TelemetryService(host).withSpan('raw-span', () => Promise.resolve());

    expect(activated).toBe(returned);
  });

  it('ends the span after activation has unwound, never before', async () => {
    const host = createFakeTracerHost();
    const order: string[] = [];
    host.activate = async (_span, fn) => {
      order.push('activate:enter');
      const result = await fn();
      order.push('activate:exit');
      return result;
    };

    await new TelemetryService(host).withSpan('ordering', () => {
      order.push('callback');
      return Promise.resolve();
    });

    // A span ended inside the activated scope would be exported before any work
    // nested under it finished.
    expect(order).toEqual(['activate:enter', 'callback', 'activate:exit']);
    expect(host.recordedSpans[0]?.ended).toBe(true);
  });
});
