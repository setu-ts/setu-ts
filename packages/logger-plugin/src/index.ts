/**
 * @module
 *
 * Structured logging plugin for the Hono Enterprise framework.
 *
 * Provides three logger implementations — `ConsoleLogger`, `PinoLogger`,
 * and `NoopLogger` — and automatic request/response logging middleware,
 * all registered under `CAPABILITIES.LOGGER` by the `LoggerPlugin`.
 *
 * Every export here is public API and documented in PUBLIC_API.md
 * (AI_GUIDELINES §10).
 */

// Plugin factory
export { LoggerPlugin } from './plugin/logger-plugin.ts';
export type { LoggerPluginOptions, LoggerTransport } from './plugin/logger-plugin.ts';

// Logger implementations
export { ConsoleLogger } from './loggers/console-logger.ts';
export type { ConsoleLoggerOptions } from './loggers/console-logger.ts';
export { NoopLogger } from './loggers/noop-logger.ts';
export type { NoopLoggerOptions } from './loggers/noop-logger.ts';
export { PinoLogger } from './loggers/pino-logger.ts';
export type { PinoFactory, PinoLoggerOptions } from './loggers/pino-logger.ts';

// Middleware
export { createRequestLoggerMiddleware } from './middleware/request-logger.ts';
export type { RequestLoggerOptions } from './middleware/request-logger.ts';
