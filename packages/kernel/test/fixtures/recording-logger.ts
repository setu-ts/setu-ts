/**
 * Test fixture — a logger plugin that records every call, by level.
 *
 * @module
 */
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger, IPlugin, IPluginContext, LogMetadata } from '@setu-ts/common';

/** One recorded log call. */
export interface LogCall {
  readonly level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly message: string;
  readonly metadata: LogMetadata | undefined;
}

/**
 * Creates a plugin providing a logger that appends each call to `calls`.
 *
 * @param calls - Where calls are recorded
 * @returns The plugin
 */
export function recordingLogger(calls: LogCall[]): IPlugin {
  const record =
    (level: LogCall['level']) =>
    (message: string, metadata?: LogMetadata): void => {
      calls.push({ level, message, metadata });
    };
  const logger: ILogger = {
    level: 'trace',
    fatal: record('fatal'),
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    trace: record('trace'),
    child: () => logger,
  };
  return {
    name: 'recording-logger',
    version: '1.0.0',
    provides: [CAPABILITIES.LOGGER],
    register(ctx: IPluginContext): void {
      ctx.services.register(CAPABILITIES.LOGGER, logger);
    },
  };
}

/**
 * The calls with one message.
 *
 * @param calls - Recorded calls
 * @param message - The message to select
 * @returns The matching calls
 */
export function withMessage(calls: readonly LogCall[], message: string): LogCall[] {
  return calls.filter((call) => call.message === message);
}
