/**
 * @module @hono-enterprise/testing
 *
 * First-party testing utilities for the Hono Enterprise framework:
 * a test application factory, mock-plugin builder, request injector,
 * mock request context, service registry double, response builder,
 * fixture manager, and streaming-response reader.
 */

export { createTestApp } from './test-app.ts';
export type { TestAppOptions } from './test-app.ts';

export { createMockPlugin } from './mock-plugin.ts';
export type { MockPluginOptions } from './mock-plugin.ts';

export { collectStream, inject } from './inject.ts';
export type { StreamingBody } from './inject.ts';

export { createTestContext } from './mock-context.ts';
export type { TestContextOptions } from './mock-context.ts';
export { MockResponse } from './mock-context.ts';

export { MockServiceRegistry } from './mock-registry.ts';

export { FixtureManager } from './fixtures/fixture-manager.ts';

// Re-exports from @hono-enterprise/kernel for convenience
export type { IKernelApplication, InjectRequest, InjectResponse } from '@hono-enterprise/kernel';
