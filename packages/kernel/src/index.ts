/**
 * @module
 *
 * Plugin kernel: plugin registry, service registry, middleware pipeline, router,
 * and application lifecycle.
 *
 * Every export here is public API and documented in PUBLIC_API.md
 * (AI_GUIDELINES §10).
 */

export type {
  ApplicationOptions,
  IKernelApplication,
  InjectRequest,
  InjectResponse,
} from './application/application.ts';

export { createApplication } from './application/application.ts';
