/** Frozen JSR package inventory and the npm migration description. */

/** The packages present on JSR at the M111f registry audit (2026-10-16). */
export const JSR_PACKAGES: readonly string[] = Object.freeze([
  'common',
  'kernel',
  'runtime',
  'testing',
  'exceptions',
  'sdk',
  'audit-plugin',
  'auth-plugin',
  'cache-plugin',
  'cloudflare-plugin',
  'config-plugin',
  'cqrs-plugin',
  'database-plugin',
  'decorator-plugin',
  'di-plugin',
  'diagnostics-plugin',
  'events-plugin',
  'feature-flags-plugin',
  'graphql-plugin',
  'grpc-plugin',
  'health-plugin',
  'http-security-plugin',
  'logger-plugin',
  'mail-plugin',
  'messaging-plugin',
  'metrics-plugin',
  'multi-tenancy-plugin',
  'notification-plugin',
  'openapi-plugin',
  'queue-plugin',
  'react-router-plugin',
  'realtime-backplane-plugin',
  'resilience-plugin',
  'scheduler-plugin',
  'secrets-plugin',
  'service-discovery-plugin',
  'session-plugin',
  'sse-plugin',
  'static-plugin',
  'storage-plugin',
  'telemetry-plugin',
  'validation-plugin',
  'view-plugin',
  'websocket-plugin',
  'worker-pool-plugin',
  'cli',
  'rest-starter',
  'microservice-starter',
  'full-stack-starter',
]);

/** Produce a JSR description within its 250-byte UTF-8 limit, preserving whole words. */
export function jsrSunsetDescription(name: string, base: string): string {
  // JSR rejects control characters rather than accepting a hidden line break.
  if (/[\p{Cc}]/u.test(name + base))
    throw new Error('JSR description contains a control character');
  const prefix = `Moved to npm as @setu-ts/${name}; JSR keeps 0.8.0 and earlier.`;
  const bytes = (text: string): number => new TextEncoder().encode(text).length;
  if (bytes(prefix) > 250) throw new Error('JSR sunset prefix exceeds 250 bytes');
  const full = `${prefix} ${base.trim()}`.trimEnd();
  if (bytes(full) <= 250) return full;
  let cut = full.lastIndexOf(' ');
  while (cut >= prefix.length && bytes(`${full.slice(0, cut)}…`) > 250) {
    cut = full.lastIndexOf(' ', cut - 1);
  }
  // The pointer must stay intact even when there is no room for an ellipsis.
  return cut < prefix.length ? prefix : `${full.slice(0, cut)}…`;
}
