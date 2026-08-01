/**
 * gRPC Health bridge tests — verifies status mapping and health check handling.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createHealthService } from '../../src/health/grpc-health-bridge.ts';
import type { IHealthService } from '@hono-enterprise/common';

describe('GrpcHealthBridge', () => {
  it('creates a health service', () => {
    const service = createHealthService(null);
    expect(service).toBeDefined();
    const typedServiceCheck = service as Record<string, unknown>;
    expect(typedServiceCheck.check).toBeDefined();
    const typedServiceType = service as Record<string, unknown>;
    expect(typeof typedServiceType.check).toBe('function');
  });

  it('returns serving when no health service provided', async () => {
    const service = createHealthService(null);
    const typedService = service as {
      check: (arg: { service?: string }) => Promise<{ status: number }>;
    };
    const result = await typedService.check({ service: '' });
    expect(result).toBeDefined();
    expect(result.status).toBe(1); // 'serving'
  });

  it('handles health service errors gracefully', async () => {
    const mockHealthService = {
      check: () => Promise.resolve({ status: 'up' as const }),
    } as unknown as IHealthService;
    const service = createHealthService(null, mockHealthService);
    const typedService = service as {
      check: (arg: { service?: string }) => Promise<{ status: number }>;
    };
    const result = await typedService.check({ service: '' });
    expect(result).toBeDefined();
    expect(result.status).toBe(1); // 'serving'
  });

  it('returns not-serving when health service reports down', async () => {
    const mockHealthService = {
      check: () => Promise.resolve({ status: 'down' as const }),
    } as unknown as IHealthService;
    const service = createHealthService(null, mockHealthService);
    const typedService = service as {
      check: (arg: { service?: string }) => Promise<{ status: number }>;
    };
    const result = await typedService.check({ service: '' });
    expect(result.status).toBe(2); // 'not-serving'
  });

  it('returns serving when health service reports degraded', async () => {
    const mockHealthService = {
      check: () => Promise.resolve({ status: 'degraded' as const }),
    } as unknown as IHealthService;
    const service = createHealthService(null, mockHealthService);
    const typedService = service as {
      check: (arg: { service?: string }) => Promise<{ status: number }>;
    };
    const result = await typedService.check({ service: '' });
    expect(result.status).toBe(1); // 'serving' (degraded maps to serving)
  });

  it('returns not-serving when health service check throws', async () => {
    const mockHealthService = {
      check: () => Promise.reject(new Error('health check failed')),
    } as unknown as IHealthService;
    const service = createHealthService(null, mockHealthService);
    const typedService = service as {
      check: (arg: { service?: string }) => Promise<{ status: number }>;
    };
    const result = await typedService.check({ service: '' });
    expect(result.status).toBe(2); // 'not-serving'
  });
});
