/**
 * @module
 *
 * Job scheduling plugin: cron, delayed, recurring jobs with distributed locking.
 *
 * @since 0.1.0
 */
export { SchedulerUnavailableError } from './errors.ts';
export { SchedulerPlugin } from './plugin/scheduler-plugin.ts';
export type {
  DistributedLockOptions,
  IDistributedLock,
  IRedisLockClient,
  SchedulerJobDefinition,
  SchedulerJobEntry,
  SchedulerPluginOptions,
} from './interfaces/index.ts';

// ── Re-exported from @setu-ts/common ────────────────────────────────

export type {
  IScheduler,
  RetryOptions,
  ScheduledJob,
  ScheduleOptions,
  SchedulerBackoff,
  SchedulerJobHandler,
} from '@setu-ts/common';
