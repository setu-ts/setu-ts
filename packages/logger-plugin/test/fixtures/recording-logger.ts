import type { LogLevel } from '@setu-ts/common';
import { NoopLogger } from '../../src/loggers/noop-logger.ts';

export class RecordingLogger extends NoopLogger {
  readonly calls: { level: LogLevel; message: string; meta?: Record<string, unknown> }[] = [];
  override info(message: string, meta?: Record<string, unknown>): void {
    this.calls.push({ level: 'info', message, ...(meta === undefined ? {} : { meta }) });
  }
  override warn(message: string, meta?: Record<string, unknown>): void {
    this.calls.push({ level: 'warn', message, ...(meta === undefined ? {} : { meta }) });
  }
  override error(message: string, meta?: Record<string, unknown>): void {
    this.calls.push({ level: 'error', message, ...(meta === undefined ? {} : { meta }) });
  }
  override child(): RecordingLogger {
    return this;
  }
}
