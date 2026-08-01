/**
 * Unit tests for the gRPC Health v1 bridge: the HealthStatus mapping, the
 * `service` field's SERVICE_UNKNOWN behavior, and the absent/failing capability
 * paths.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  createHealthService,
  mapHealthStatus,
  resolveServingStatus,
} from '../../src/health/grpc-health-bridge.ts';
import type { HealthReport, HealthStatus, IHealthService } from '@hono-enterprise/common';

/** The enum values from grpc/health/v1/health.proto. */
const SERVING = 1;
const NOT_SERVING = 2;
const SERVICE_UNKNOWN = 3;

const SERVICE_NAMES = ['pkg.Svc', 'grpc.health.v1.Health'];

function healthServiceReporting(status: HealthStatus): IHealthService {
  return {
    check: () =>
      Promise.resolve({ status, info: {}, details: {}, timestamp: 0 } as unknown as HealthReport),
  } as unknown as IHealthService;
}

function healthServiceThrowing(): IHealthService {
  return { check: () => Promise.reject(new Error('probe failed')) } as unknown as IHealthService;
}

/** Drives the real `Check` method rather than only the helper. */
async function check(
  service: Record<string, unknown>,
  request: { service?: string },
): Promise<number> {
  const method = service.check as (r: { service?: string }) => Promise<{ status: number }>;
  return (await method(request)).status;
}

describe('mapHealthStatus', () => {
  it("maps 'up' to serving", () => {
    expect(mapHealthStatus('up')).toBe('serving');
  });

  it("maps 'down' to not-serving", () => {
    expect(mapHealthStatus('down')).toBe('not-serving');
  });

  it("maps 'degraded' to serving, not not-serving", () => {
    // Reporting NOT_SERVING here would make Kubernetes withdraw the replica
    // exactly when the app is functional but under stress.
    expect(mapHealthStatus('degraded')).toBe('serving');
  });
});

describe('resolveServingStatus', () => {
  it('answers serving with no health capability registered', async () => {
    expect(await resolveServingStatus(undefined, SERVICE_NAMES, '')).toBe('serving');
  });

  it('maps each report status for the whole-server query', async () => {
    expect(await resolveServingStatus(healthServiceReporting('up'), SERVICE_NAMES, '')).toBe(
      'serving',
    );
    expect(await resolveServingStatus(healthServiceReporting('down'), SERVICE_NAMES, '')).toBe(
      'not-serving',
    );
    expect(await resolveServingStatus(healthServiceReporting('degraded'), SERVICE_NAMES, '')).toBe(
      'serving',
    );
  });

  it('answers service-unknown for a name the server does not serve', async () => {
    expect(
      await resolveServingStatus(healthServiceReporting('up'), SERVICE_NAMES, 'no.Such'),
    ).toBe('service-unknown');
  });

  it('answers service-unknown even when the server is otherwise down', async () => {
    // The name is wrong; that is the more specific answer.
    expect(
      await resolveServingStatus(healthServiceReporting('down'), SERVICE_NAMES, 'no.Such'),
    ).toBe('service-unknown');
  });

  it('answers service-unknown for an unknown name with no health capability', async () => {
    expect(await resolveServingStatus(undefined, SERVICE_NAMES, 'no.Such')).toBe(
      'service-unknown',
    );
  });

  it('resolves a named service the server does serve through the health report', async () => {
    expect(
      await resolveServingStatus(healthServiceReporting('down'), SERVICE_NAMES, 'pkg.Svc'),
    ).toBe('not-serving');
  });

  it('answers not-serving when the health check rejects', async () => {
    // A probe that throws is not evidence of health.
    expect(await resolveServingStatus(healthServiceThrowing(), SERVICE_NAMES, '')).toBe(
      'not-serving',
    );
  });
});

describe('createHealthService', () => {
  it('encodes the serving-status enum values from the proto', async () => {
    const service = createHealthService(healthServiceReporting('up'), SERVICE_NAMES);
    expect(await check(service, { service: '' })).toBe(SERVING);

    const down = createHealthService(healthServiceReporting('down'), SERVICE_NAMES);
    expect(await check(down, { service: '' })).toBe(NOT_SERVING);

    const unknown = createHealthService(healthServiceReporting('up'), SERVICE_NAMES);
    expect(await check(unknown, { service: 'no.Such' })).toBe(SERVICE_UNKNOWN);
  });

  it('treats an absent service field as the whole-server query', async () => {
    const service = createHealthService(healthServiceReporting('up'), SERVICE_NAMES);
    expect(await check(service, {})).toBe(SERVING);
  });

  it('answers SERVING with no health capability', async () => {
    const service = createHealthService(undefined, SERVICE_NAMES);
    expect(await check(service, { service: '' })).toBe(SERVING);
  });

  it('exposes only Check, leaving List and Watch to Connect unimplemented responder', () => {
    const service = createHealthService(undefined, SERVICE_NAMES);
    expect(Object.keys(service)).toEqual(['check']);
  });
});
