/** Single source of truth for the Node and Deno package-test lanes (M111b). */
/** Converted suites that still prove Deno runtime behavior. */
export const DENO_LANE_TESTS = [
  // Diagnostics connector proofs run on both supported listener runtimes.
  'test/inspect-local-diagnostics.test.ts',
  'packages/diagnostics-plugin/test/unit/cache-observations.test.ts',
  'packages/diagnostics-plugin/test/unit/outbound-http-observations.test.ts',
  'packages/diagnostics-plugin/test/unit/realtime-observations.test.ts',
  'packages/diagnostics-plugin/test/unit/scheduler-observations.test.ts',
  'packages/diagnostics-plugin/test/unit/storage-observations.test.ts',

  'packages/websocket-plugin/test/integration/guarded-upgrade.test.ts',
  'packages/websocket-plugin/test/integration/upgrade-body-cap-slot.test.ts',
  'packages/websocket-plugin/test/integration/upgrade-guards.test.ts',
  'packages/websocket-plugin/test/integration/websocket-integration.test.ts',

  'packages/cli/test/unit/process-boundary.test.ts',
  'packages/runtime/test/unit/create-runtime-services.test.ts',
  'packages/runtime/test/e2e/worker-host-real.test.ts',
  'packages/runtime/test/e2e/deno-stop-bounded.test.ts',
  'packages/runtime/test/integration/deno-http-adapter.test.ts',
  'packages/runtime/test/unit/deno-dns-resolver.test.ts',
  'packages/runtime/test/unit/deno-http-adapter-rpc.test.ts',
  'packages/runtime/test/unit/deno-http-adapter.test.ts',
  'packages/runtime/test/unit/deno-read-stream.test.ts',
  'packages/runtime/test/unit/deno-runtime.test.ts',
  'packages/runtime/test/unit/deno-upgrade-order.test.ts',
  'packages/runtime/test/unit/deno-ws-upgrader.test.ts',
  'packages/diagnostics-plugin/test/e2e/authorization-explanations.test.ts',
  'packages/diagnostics-plugin/test/e2e/cache-observations.test.ts',
  'packages/diagnostics-plugin/test/e2e/config-provenance.test.ts',
  'packages/diagnostics-plugin/test/e2e/distributed-tracing.test.ts',
  'packages/diagnostics-plugin/test/e2e/event-observations.test.ts',
  'packages/diagnostics-plugin/test/e2e/health-observations.test.ts',
  'packages/diagnostics-plugin/test/e2e/local-connector.test.ts',
  'packages/diagnostics-plugin/test/e2e/outbound-http-observations.test.ts',
  'packages/diagnostics-plugin/test/e2e/queue-observations.test.ts',
  'packages/diagnostics-plugin/test/e2e/realtime-observations.test.ts',
  'packages/diagnostics-plugin/test/e2e/scheduler-observations.test.ts',
  'packages/diagnostics-plugin/test/e2e/storage-observations.test.ts',
  'packages/diagnostics-plugin/test/integration/activation.test.ts',
  'packages/diagnostics-plugin/test/integration/core-conformance.test.ts',
  'packages/diagnostics-plugin/test/integration/lifecycle.test.ts',
  'packages/diagnostics-plugin/test/integration/security.test.ts',
  'packages/runtime/test/unit/local-diagnostics-listener.test.ts',
  'packages/runtime/test/integration/local-diagnostics-listener-conformance.test.ts',
  'packages/runtime/test/integration/read-stream-real.test.ts',
  'packages/runtime/test/integration/peer-address-real.test.ts',
  'packages/runtime/test/integration/signal-real.test.ts',
  'packages/realtime-backplane-plugin/test/integration/realtime-observations-redis.test.ts',
] as const;

/** Suites whose subject needs the real Deno host. */
export const NODE_EXCLUDED_TESTS = [
  'packages/websocket-plugin/test/integration/guarded-upgrade.test.ts',
  'packages/websocket-plugin/test/integration/upgrade-body-cap-slot.test.ts',
  'packages/websocket-plugin/test/integration/upgrade-guards.test.ts',
  'packages/websocket-plugin/test/integration/websocket-integration.test.ts',

  'packages/runtime/test/e2e/worker-host-real.test.ts',
  'packages/runtime/test/e2e/deno-stop-bounded.test.ts',
  'packages/runtime/test/integration/deno-http-adapter.test.ts',
  'packages/runtime/test/unit/deno-dns-resolver.test.ts',
  'packages/runtime/test/unit/deno-http-adapter-rpc.test.ts',
  'packages/runtime/test/unit/deno-http-adapter.test.ts',
  'packages/runtime/test/unit/deno-read-stream.test.ts',
  'packages/runtime/test/unit/deno-runtime.test.ts',
  'packages/runtime/test/unit/deno-upgrade-order.test.ts',
  'packages/runtime/test/unit/deno-ws-upgrader.test.ts',
] as const;

/** Sources measured only by the Deno lane. */
export const DENO_ONLY_SOURCES = [
  'packages/runtime/src/adapters/deno/deno-dns-resolver.ts',
  'packages/runtime/src/adapters/deno/deno-http-adapter.ts',
  'packages/runtime/src/adapters/deno/deno-runtime.ts',
  'packages/runtime/src/adapters/deno/deno-ws-upgrader.ts',
  'packages/runtime/src/diagnostics/deno-local-diagnostics-listener.ts',
] as const;
