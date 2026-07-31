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
// Config-driven composition: options derived from configuration that is only
// known at runtime, resolved before the plugins are constructed.
export { createFullStackAppFromConfig } from './from-config.ts';
export type { FromConfigOptions } from './from-config.ts';
// Re-exported because `FullStackStarterOptions` inherits the `realtime` arm
// through the microservice and REST tiers, so naming its type must not require
// reaching past this package. Routed through the microservice tier, which is the
// only starter this package pins — the same chain the option types follow.
export type { RealtimeArm } from '@hono-enterprise/microservice-starter';
