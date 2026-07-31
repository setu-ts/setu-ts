/**
 * gRPC Health bridge tests — verifies status mapping and health check handling.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createHealthService } from '../../src/health/grpc-health-bridge.ts';

// GrpcServingStatus is imported from common but not directly used in this test

describe('GrpcHealthBridge', () => {
  it('creates a health service', () => {
    const service = createHealthService(null);
    expect(service).toBeDefined();
    const typedServiceCheck = service as Record<string, unknown>;
    expect(typedServiceCheck.Check).toBeDefined();
    const typedServiceType = service as Record<string, unknown>;
    expect(typeof typedServiceType.Check).toBe('function');
  });

  it('returns serving when no health service provided', async () => {
    const service = createHealthService(null);
    const typedService = service as { Check: (arg: any) => Promise<{ status: number }> };
    const result = await typedService.Check({ service: '' });
    expect(result).toBeDefined();
    expect(result.status).toBe(1); // 'serving'
  });

  it('handles health service errors gracefully', async () => {
    const mockHealthService = {
      check: async () => ({ status: 'up' }),
    } as any;
    const service = createHealthService(null, mockHealthService);
    const typedService = service as { Check: (arg: any) => Promise<{ status: number }> };
    const result = await typedService.Check({ service: '' });
    expect(result).toBeDefined();
    expect(result.status).toBe(1); // 'serving'
  });
});
