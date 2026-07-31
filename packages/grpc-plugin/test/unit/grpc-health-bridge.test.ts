/**
 * gRPC Health bridge tests — verifies status mapping and health check handling.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { handleHealthCheck, mapHealthStatus, type GrpcServingStatus } from '../../src/health/grpc-health-bridge.ts';

describe('GrpcHealthBridge', () => {
  describe('mapHealthStatus', () => {
    it('maps "up" to serving', () => {
      expect(mapHealthStatus('up')).toBe('serving' as GrpcServingStatus);
    });

    it('maps "down" to not-serving', () => {
      expect(mapHealthStatus('down')).toBe('not-serving' as GrpcServingStatus);
    });

    it('maps "degraded" to serving', () => {
      expect(mapHealthStatus('degraded')).toBe('serving' as GrpcServingStatus);
    });
  });

  describe('handleHealthCheck', () => {
    it('returns serving when no health capability is available', async () => {
      const result = await handleHealthCheck({ service: '' }, { healthService: undefined });
      expect(result.status).toBe('serving');
    });

    it('returns mapped status from health service', async () => {
      const mockHealthService = {
        check: async () => ({ status: 'up', data: {} }),
      };
      const result = await handleHealthCheck({ service: '' }, { healthService: mockHealthService });
      expect(result.status).toBe('serving');
    });

    it('returns not-serving when health check throws', async () => {
      const mockHealthService = {
        check: async () => { throw new Error('failed'); },
      };
      const consoleSpy = mock(console, 'warn').mockImplementation(() => {});
      const result = await handleHealthCheck({ service: '' }, { 
        healthService: mockHealthService,
        logger: (...msg) => console.log(msg),
      });
      expect(result.status).toBe('not-serving');
      consoleSpy.restore();
    });

    it('returns service-unknown for unknown service name', async () => {
      const result = await handleHealthCheck({ service: 'Unknown.Service' }, { healthService: undefined });
      expect(result.status).toBe('service-unknown');
    });
  });
});