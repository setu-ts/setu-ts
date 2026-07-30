/**
 * @module
 *
 * Full-stack starter bundle — every capability plugin with sensible defaults.
 *
 * Provides a single factory {@linkcode createFullStackApp} that returns a fully wired
 * {@linkcode IKernelApplication} with the curated full-stack plugin set and error-handling
 * middleware. Also exposes the option type {@linkcode FullStackStarterOptions} and the
 * plugin builder {@linkcode buildFullStackPlugins} for advanced composition.
 *
 * @see {@link https://jsr.io/@hono-enterprise/full-stack-starter}
 */

export { createFullStackApp } from './app.ts';
export type { FullStackStarterOptions } from './options.ts';
export { buildFullStackPlugins } from './app.ts';
