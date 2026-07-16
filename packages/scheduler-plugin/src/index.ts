/**
 * @module
 *
 * Job scheduling plugin: cron, delayed, recurring jobs with distributed locking.
 *
 * @since 0.1.0
 */
export { SchedulerPlugin } from './plugin/scheduler-plugin.ts';
export type {
  DistributedLockOptions,
  IDistributedLock,
  IRedisLockClient,
  SchedulerPluginOptions,
} from './interfaces/index.ts';

// ── Re-exported from @hono-enterprise/common ────────────────────────────────

export type {
  IScheduler,
  RetryOptions,
  ScheduledJob,
  ScheduleOptions,
  SchedulerBackoff,
  SchedulerJobHandler,
} from '@hono-enterprise/common';
