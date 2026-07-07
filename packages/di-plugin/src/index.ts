/**
 * @module
 *
 * Optional dependency injection container plugin.
 *
 * Provides `DiPlugin` which registers an {@linkcode IContainer} under
 * `CAPABILITIES.DI_CONTAINER`. The container supports singleton, scoped,
 * and transient lifecycles, constructor injection, factory and value
 * providers, circular dependency detection, hierarchical scopes, and
 * optional auto-registration fallback to the kernel's ServiceRegistry.
 *
 * Every export here is public API and documented in PUBLIC_API.md
 * (AI_GUIDELINES §10).
 */

// Plugin factory
export { DiPlugin } from './plugin/di-plugin.ts';
export type { DiPluginOptions } from './plugin/di-plugin.ts';

// Container builder and factory
export { ContainerBuilder, createContainer } from './container/container-builder.ts';

// Container implementation (for direct construction or testing)
export { DiContainer } from './container/container.ts';
export type { ContainerConfig, ExternalResolver } from './container/container.ts';

// Internal building blocks (exported for testing and advanced use)
export { CircularDetector } from './container/circular-detector.ts';
export { ProviderRegistry } from './container/provider-registry.ts';
export type { ProviderEntry } from './container/provider-registry.ts';
export { ScopeManager } from './container/scope-manager.ts';
