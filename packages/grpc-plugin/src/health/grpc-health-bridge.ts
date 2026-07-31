/**
 * gRPC Health v1 service bridge — implements `grpc.health.v1.Health` by
 * bridging to the M20 health plugin via the capability token. Only the `Check`
 * method is implemented; `List` and `Watch` are left unimplemented.
 *
 * @module
 */

import { type IHealthService } from '@hono-enterprise/common';
import { GrpcServingStatus } from '@hono-enterprise/common';

/**
 * Creates a gRPC Health v1 service implementation.
 * 
 * The Check method resolves the CAPABILITIES.HEALTH capability if present,
 * otherwise returns SERVING. It maps HealthStatus values to gRPC ServingStatus.
 * 
 * @param _connectRuntime - The Connect runtime (needed for descriptor operations, unused in Check)
 * @param healthService - Optional IHealthService capability
 * @returns A Health service implementation object
 */
export function createHealthService(
  _connectRuntime: unknown,
  healthService?: IHealthService,
): unknown {
  return {
    Check: async (request: any) => {
      const _service = request.service || ''; // service name or empty string for server-wide check
      
      let status: GrpcServingStatus = 'serving';

      if (healthService) {
        try {
          const report = await healthService.check();
          switch (report.status) {
            case 'up':
              status = 'serving';
              break;
            case 'down':
              status = 'not-serving';
              break;
            case 'degraded':
              status = 'serving'; // degraded still serving per plan
              break;
          }
        } catch (e) {
          // If health check throws, treat as NOT_SERVING
          status = 'not-serving';
        }
      } else {
        // No health capability available — report SERVING
        status = 'serving';
      }

      // Map to gRPC serving status enum: SERVING = 1, NOT_SERVING = 2, SERVICE_UNKNOWN = 3
      const servingStatus: Record<GrpcServingStatus, number> = {
        'serving': 1,
        'not-serving': 2,
        'service-unknown': 3,
        'unknown': 0,
      };

      return {
        status: servingStatus[status],
      };
    },
  };
}
