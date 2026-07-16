import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, none, ok, PLUGIN_PRIORITY, some } from '../../src/index.ts';
import type {
  IScheduler,
  RetryOptions,
  ScheduledJob,
  ScheduleOptions,
  SchedulerBackoff,
  SchedulerJobHandler,
} from '../../src/index.ts';

describe('@hono-enterprise/common barrel', () => {
  it('should export the capability token constants', () => {
    expect(CAPABILITIES.LOGGER).toBe('logger');
    expect(PLUGIN_PRIORITY.NORMAL).toBe(500);
  });

  it('should export the utility constructors', () => {
    expect(ok(1).success).toBe(true);
    expect(some(1).present).toBe(true);
    expect(none().present).toBe(false);
  });

  it('should export scheduler types', () => {
    // Compile-time verification that scheduler types resolve from barrel
    const _scheduler: IScheduler = {} as IScheduler;
    const _job: ScheduledJob<string> = { id: '', name: '', data: '', attempts: 0 };
    const _handler: SchedulerJobHandler<string> = () => {};
    const _options: ScheduleOptions<string> = {};
    const _retry: RetryOptions = { limit: 1, delay: 100, backoff: 'fixed' };
    const _backoff: SchedulerBackoff = 'fixed';
    expect(_scheduler).toBeDefined();
    expect(_job).toBeDefined();
    expect(_handler).toBeDefined();
    expect(_options).toBeDefined();
    expect(_retry).toBeDefined();
    expect(_backoff).toBe('fixed');
  });

  it('should have SCHEDULER capability token', () => {
    expect(CAPABILITIES.SCHEDULER).toBe('scheduler');
  });
});
