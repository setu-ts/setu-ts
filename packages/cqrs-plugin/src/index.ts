/**
 * @module
 *
 * CQRS plugin: command bus, query bus, and pipeline behaviors.
 *
 * @example
 * ```typescript
 * import { CqrsPlugin } from '@hono-enterprise/cqrs-plugin';
 *
 * app.register(CqrsPlugin({ behaviors: [timingBehavior] }));
 * ```
 */
export { CqrsPlugin } from './plugin/cqrs-plugin.ts';
export { CommandBus } from './bus/command-bus.ts';
export { QueryBus } from './bus/query-bus.ts';
export { HandlerNotFoundError } from './errors/handler-not-found.ts';
export type { CqrsPluginOptions } from './interfaces/index.ts';

// Re-export common types for convenience
export type {
  CqrsCommand,
  CqrsCommandHandler,
  CqrsPipelineBehavior,
  CqrsQuery,
  CqrsQueryHandler,
  CqrsRequest,
  ICommandBus,
  ICqrsFacade,
  IQueryBus,
} from '@hono-enterprise/common';
