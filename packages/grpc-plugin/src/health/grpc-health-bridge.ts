/**
 * gRPC Health v1 service bridge — implements `grpc.health.v1.Health` by
 * bridging to the M20 health plugin via the capability token. Only the `Check`
 * method is implemented; `List` and `Watch` are left unimplemented.
 *
 * @module
 */

import { type ConnectRuntime } from '../interfaces/connect-runtime.ts';

/**
 * Creates a gRPC Health v1 service implementation.
 * 
 * Note: This is a simplified stub that returns a placeholder response.
 * In a full implementation, it would resolve the health capability
 * and map the health status appropriately.
 */
export function createHealthService(_connectRuntime: ConnectRuntime): unknown {
  return {
    Check: async (_request: any, _callback?: any) => ({
      status: 'SERVING' as const,
    }),
  };
}