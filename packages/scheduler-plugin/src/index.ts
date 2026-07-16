/**
 * @module
 *
 * Job scheduling plugin: cron, delayed, recurring jobs with distributed locking.
 *
 * @since 0.1.0
 */
export { SchedulerPlugin } from './plugin/scheduler-plugin.ts';
export type { IDistributedLock, SchedulerPluginOptions } from './interfaces/index.ts';
