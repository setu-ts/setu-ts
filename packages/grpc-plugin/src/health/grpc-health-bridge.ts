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
 * `'degraded'` maps to `not-serving`: the health plugin already withdraws a
 * degraded replica from its Service via `/ready` (503), so reporting `SERVING`
 * here would leave the two health faces of one process disagreeing — gRPC
 * clients would keep load-balancing onto a replica HTTP has taken out of
 * rotation. The old comment argued `NOT_SERVING` would "shed capacity in the
 * wrong direction", but that withdrawal already happens on the HTTP side;
 * agreeing is the point (M70c, plan §3.6).
 */
export function mapHealthStatus(status: 'up' | 'down' | 'degraded'): GrpcServingStatus {
  switch (status) {
    case 'up':
      return 'serving';
    case 'degraded':
      return 'not-serving';
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
