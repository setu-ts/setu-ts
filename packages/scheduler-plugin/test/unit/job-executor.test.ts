/**
 * Tests for job executor.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  ILogger,
  RetryOptions,
  ScheduledJob,
  SchedulerJobHandler,
} from '@hono-enterprise/common';
import { run } from '../../src/jobs/job-executor.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

describe('JobExecutor.run', () => {
  it('runs handler successfully', async () => {
    const runtime = new FakeRuntime();
    let called = false;
    const handler: SchedulerJobHandler = () => {
      called = true;
    };
    await run('id1', 'job1', handler, undefined, undefined, { runtime });
    expect(called).toBe(true);
  });

  it('passes job to handler', async () => {
    const runtime = new FakeRuntime();
    let receivedJob: ScheduledJob<string> | undefined;
    const handler: SchedulerJobHandler<string> = (job) => {
      receivedJob = job;
    };
    await run('id1', 'job1', handler, 'payload', undefined, { runtime });
    expect(receivedJob).toBeDefined();
    expect(receivedJob!.id).toBe('id1');
    expect(receivedJob!.name).toBe('job1');
    expect(receivedJob!.data).toBe('payload');
    expect(receivedJob!.attempts).toBe(1);
  });

  it('retries on failure and succeeds', async () => {
    const runtime = new FakeRuntime();
    let attempts = 0;
    const handler: SchedulerJobHandler = () => {
      attempts++;
      if (attempts < 2) {
        throw new Error('fail');
      }
    };
    const retry: RetryOptions = { limit: 3, delay: 100, backoff: 'fixed' };
    // Run in a promise that we await
    const promise = run('id1', 'job1', handler, undefined, retry, { runtime });
    // Advance clock past backoff delays so pending setTimeout resolves
    runtime.advance(1000);
    await promise;
    expect(attempts).toBe(2);
  });

  it('gives up after limit exhausted', async () => {
    const runtime = new FakeRuntime();
    let attempts = 0;
    const handler: SchedulerJobHandler = () => {
      attempts++;
      throw new Error('fail');
    };
    const retry: RetryOptions = { limit: 2, delay: 10, backoff: 'fixed' };
    const promise = run('id1', 'job1', handler, undefined, retry, { runtime });
    runtime.advance(1000);
    try {
      await promise;
    } catch {
      // expected
    }
    expect(attempts).toBe(2);
  });

  it('no retry when retry undefined', async () => {
    const runtime = new FakeRuntime();
    let attempts = 0;
    const handler: SchedulerJobHandler = () => {
      attempts++;
      throw new Error('fail');
    };
    try {
      await run('id1', 'job1', handler, undefined, undefined, { runtime });
    } catch {
      // expected
    }
    expect(attempts).toBe(1);
  });

  it('warns on retry attempt failure', async () => {
    const runtime = new FakeRuntime();
    let attempts = 0;
    const logWarns: string[] = [];
    const logger: ILogger = {
      level: 'error' as const,
      fatal: () => {},
      error: () => {},
      warn: (msg: string) => {
        logWarns.push(msg);
      },
      info: () => {},
      debug: () => {},
      trace: () => {},
      child: () => logger,
    };
    const handler: SchedulerJobHandler = () => {
      attempts++;
      throw new Error('fail');
    };
    const retry: RetryOptions = { limit: 2, delay: 100, backoff: 'fixed' };
    const promise = run('id1', 'job1', handler, undefined, retry, { runtime, logger });
    runtime.advance(1000);
    try {
      await promise;
    } catch {
      // expected
    }
    expect(logWarns.length).toBeGreaterThan(0);
    expect(logWarns[0]).toContain('retrying');
  });

  it('errors on final failure', async () => {
    const runtime = new FakeRuntime();
    let attempts = 0;
    const logErrors: string[] = [];
    const logger: ILogger = {
      level: 'error' as const,
      fatal: () => {},
      error: (msg: string) => {
        logErrors.push(msg);
      },
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
      child: () => logger,
    };
    const handler: SchedulerJobHandler = () => {
      attempts++;
      throw new Error('permanent failure');
    };
    const retry: RetryOptions = { limit: 1, delay: 100, backoff: 'fixed' };
    try {
      await run('id1', 'job1', handler, undefined, retry, { runtime, logger });
    } catch {
      // expected
    }
    expect(attempts).toBe(1);
    expect(logErrors.length).toBe(1);
    expect(logErrors[0]).toContain('failed after 1 attempt');
  });

  it('passes attempt count to handler', async () => {
    const runtime = new FakeRuntime();
    const attemptValues: number[] = [];
    const handler: SchedulerJobHandler = (job) => {
      attemptValues.push(job.attempts);
      if (job.attempts < 2) {
        throw new Error('fail');
      }
    };
    const retry: RetryOptions = { limit: 3, delay: 100, backoff: 'fixed' };
    const promise = run('id1', 'job1', handler, undefined, retry, { runtime });
    runtime.advance(1000);
    await promise;
    expect(attemptValues).toEqual([1, 2]);
  });

  it('throws with Error message on retry exhaustion (non-Error throw)', async () => {
    const runtime = new FakeRuntime();
    let attempts = 0;
    const logErrors: string[] = [];
    const logger: ILogger = {
      level: 'error' as const,
      fatal: () => {},
      error: (_msg: string, meta?: unknown) => {
        if (meta && typeof meta === 'object' && 'error' in meta) {
          logErrors.push(String(meta.error));
        }
      },
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
      child: () => logger,
    };
    const handler: SchedulerJobHandler = () => {
      attempts++;
      throw 'string error';
    };
    const retry: RetryOptions = { limit: 1, delay: 100, backoff: 'fixed' };
    try {
      await run('id1', 'job1', handler, undefined, retry, { runtime, logger });
    } catch {
      // expected
    }
    expect(attempts).toBe(1);
    expect(logErrors.length).toBe(1);
    expect(logErrors[0]).toBe('string error');
  });
});
