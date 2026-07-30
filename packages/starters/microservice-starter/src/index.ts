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

export { createMicroserviceApp } from './microservice-app.ts';
export type { MicroserviceStarterOptions } from './options.ts';
export { buildMicroservicePlugins } from './microservice-app.ts';
