/**
 * @module
 *
 * REST starter bundle — opinionated plugin composition for building REST APIs.
 *
 * Provides a single factory {@linkcode createRestApp} that returns a fully wired
 * {@linkcode IKernelApplication} with the curated REST plugin set and error-handling
 * middleware. Also exposes the option type {@linkcode RestStarterOptions} and the
 * plugin builder {@linkcode buildRestPlugins} for advanced composition.
 *
 * @see {@link https://jsr.io/@setu-ts/rest-starter}
 */

export { createRestApp } from './app.ts';
export type { RealtimeArm, RestStarterOptions } from './options.ts';
export { buildRestPlugins } from './app.ts';
