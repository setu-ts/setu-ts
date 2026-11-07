/**
 * The OpenTelemetry preload a generated Node project starts with (M131a X88-4).
 *
 * Every Redis, AMQP and Kafka driver this framework uses is loaded lazily, by a
 * guarded `await import('ioredis')` that the Workers bundling rule requires. In
 * an ESM application, OpenTelemetry's instrumentations can only patch such an
 * import when the `import-in-the-middle` loader hook is registered BEFORE the
 * driver loads; registering it from inside a plugin is too late, and would need
 * a runtime-specific API in plugin code. So the hook is registered by a preload
 * passed to `node --import`, ahead of the application.
 *
 * Measured on Node 24 (x88-io, 2026-11-02): with this preload a bare
 * `await import('ioredis')` is instrumented; without it, it is not; with
 * `@opentelemetry/instrumentation` not installed, `register` throws, the
 * `catch` swallows it, and the application starts with nothing wrapped. That
 * is what lets every Node project carry the preload, telemetry or not.
 *
 * Node only: Deno and Bun scripts carry no preload, since OpenTelemetry's
 * auto-instrumentation records `unsupported platform` there anyway.
 *
 * @module
 */

/** The preload's path, relative to the project (or workspace member) root. */
export const TELEMETRY_PRELOAD_PATH: string = 'instrumentation.mjs';

/** The `node` flag that runs the preload before the application. */
export const TELEMETRY_PRELOAD_FLAG: string = `--import ./${TELEMETRY_PRELOAD_PATH}`;

/** The preload's contents. */
export const TELEMETRY_PRELOAD_CONTENTS: string = `// Registers OpenTelemetry's ESM loader hook before the application loads, so
// the Redis, AMQP and Kafka drivers the plugins import lazily can be traced.
// The start scripts and the image run this with \`node --import\`.
//
// Without @opentelemetry/instrumentation installed this does nothing and the
// application starts normally. \`setu add telemetry\` installs it.
import { register } from 'node:module';

try {
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
} catch {
  // No instrumentation package: start without the hook.
}
`;
