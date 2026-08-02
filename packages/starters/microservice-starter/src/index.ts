/**
 * @module
 *
 * Microservice starter bundle — REST starter plus messaging, queue, telemetry, and resilience.
 *
 * Provides a single factory {@linkcode createMicroserviceApp} that returns a fully wired
 * {@linkcode IKernelApplication} with the curated microservice plugin set and error-handling
 * middleware. Also exposes the option type {@linkcode MicroserviceStarterOptions} and the
 * plugin builder {@linkcode buildMicroservicePlugins} for advanced composition.
 *
 * @see {@link https://jsr.io/@hono-enterprise/microservice-starter}
 */

export { createMicroserviceApp } from './app.ts';
export type { MicroserviceStarterOptions } from './options.ts';
export { buildMicroservicePlugins } from './app.ts';
// Re-exported because `MicroserviceStarterOptions` inherits the `realtime` arm
// from the REST tier, so naming its type must not require reaching past this
// package.
export type { RealtimeArm } from '@hono-enterprise/rest-starter';
