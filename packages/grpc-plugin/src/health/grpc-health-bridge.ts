/**
 * gRPC Health v1 bridge — implements `grpc.health.v1.Health/Check` over the M20
 * health capability, resolved through `CAPABILITIES.HEALTH` rather than by
 * importing the health plugin.
 *
 * `List` and `Watch` are deliberately not implemented; Connect answers an
 * omitted method with `unimplemented`, which is the correct gRPC response.
 * `Watch` would need change notifications `IHealthService` does not expose, and
 * `List` is keyed by gRPC service name where the framework's report is keyed by
 * indicator name (plan §3.6).
 *
 * @module
 */

import type { GrpcServingStatus, IHealthService } from '@setu-ts/common';

/** `grpc.health.v1.HealthCheckRequest`. */
interface HealthCheckRequest {
  readonly service?: string;
}

/** `grpc.health.v1.HealthCheckResponse` init object. */
interface HealthCheckResponse {
  readonly status: number;
}

/**
 * `grpc.health.v1.HealthCheckResponse.ServingStatus`, from the embedded
 * descriptor set: `UNKNOWN = 0`, `SERVING = 1`, `NOT_SERVING = 2`,
 * `SERVICE_UNKNOWN = 3`.
 */
const SERVING_STATUS: Record<GrpcServingStatus, number> = {
  'unknown': 0,
  'serving': 1,
  'not-serving': 2,
  'service-unknown': 3,
};

/**
 * Maps a framework {@linkcode HealthStatus} onto a gRPC serving status.
 *
 * `'degraded'` maps to `serving`: degraded means impaired but still serving,
 * and reporting `NOT_SERVING` would make Kubernetes withdraw the replica from
 * its Service exactly when the application is functional but under stress —
 * shedding capacity in the wrong direction (plan §3.6).
 */
export function mapHealthStatus(status: 'up' | 'down' | 'degraded'): GrpcServingStatus {
  switch (status) {
    case 'up':
      return 'serving';
    case 'degraded':
      return 'serving';
    case 'down':
      return 'not-serving';
  }
}

/**
 * Resolves the serving status for one `Check` call.
 *
 * Split out from the service object so every branch is unit-testable without
 * going through Connect.
 *
 * @param healthService - The resolved health capability, or `undefined` when no
 *   health plugin is registered.
 * @param serviceNames - Every gRPC service name this server exposes, used to
 *   answer `SERVICE_UNKNOWN` for a name the server does not serve.
 * @param requestedService - The `service` field. The empty string (or absent)
 *   means "the whole server" and yields the mapped aggregate.
 */
export async function resolveServingStatus(
  healthService: IHealthService | undefined,
  serviceNames: readonly string[],
  requestedService: string,
): Promise<GrpcServingStatus> {
  // A named service the server does not serve is SERVICE_UNKNOWN, regardless of
  // overall health — the empty string means the whole server.
  if (requestedService !== '' && !serviceNames.includes(requestedService)) {
    return 'service-unknown';
  }

  if (healthService === undefined) {
    return 'serving';
  }

  try {
    const report = await healthService.check();
    return mapHealthStatus(report.status);
  } catch {
    // A health check that throws is not evidence of health.
    return 'not-serving';
  }
}

/**
 * Creates the `grpc.health.v1.Health` implementation (`Check` only).
 *
 * @param healthService - The resolved `CAPABILITIES.HEALTH` service, if any.
 *   Absent, `Check` answers `SERVING`.
 * @param serviceNames - Every gRPC service name the server exposes.
 */
export function createHealthService(
  healthService: IHealthService | undefined,
  serviceNames: readonly string[],
): Record<string, unknown> {
  return {
    async check(request: HealthCheckRequest): Promise<HealthCheckResponse> {
      const status = await resolveServingStatus(
        healthService,
        serviceNames,
        request?.service ?? '',
      );
      return { status: SERVING_STATUS[status] };
    },
  };
}
