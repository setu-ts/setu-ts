/**
 * Tests for job executor.
 */
import { describe, expect, it } from 'vitest';
import type { ILogger, RetryOptions, ScheduledJob, SchedulerJobHandler } from '@setu-ts/common';
import { run } from '../../src/jobs/job-executor.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

describe('JobExecutor.run', () => {
  it('an already aborted run settles without invoking the handler', async () => {
    const runtime = new FakeRuntime();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const outcome = await run(
      'id1',
      'cancelled',
      () => {
        calls++;
      },
      undefined,
      undefined,
      {
        runtime,
        signal: controller.signal,
      },
    );
    expect(outcome).toBe('cancelled');
    expect(calls).toBe(0);
    expect(runtime.getPendingTimerCount()).toBe(0);
  });

  it('aborting during a failing handler settles without arming backoff', async () => {
    const runtime = new FakeRuntime();
    const controller = new AbortController();
    const pending = run(
      'id1',
      'cancelled',
      () => {
        controller.abort();
        throw new Error('failed after cancellation');
      },
      undefined,
      { limit: 3, delay: 1000, backoff: 'fixed' },
      { runtime, signal: controller.signal },
    );
    expect(runtime.getPendingTimerCount()).toBe(0);
    await expect(pending).resolves.toBe('cancelled');
  });

  it('runs handler successfully', async () => {
    const runtime = new FakeRuntime();
    let called = false;
    const handler: SchedulerJobHandler = () => {
      called = true;
    };
    await expect(run('id1', 'job1', handler, undefined, undefined, { runtime })).resolves.toBe(
      'succeeded',
    );
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

  it('uses exponential backoff between retries', async () => {
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
      if (attempts < 3) {
        throw new Error('fail');
      }
    };
    const retry: RetryOptions = { limit: 3, delay: 100, backoff: 'exponential' };
    const promise = run('id1', 'job1', handler, undefined, retry, { runtime, logger });
    // First retry: 100ms (2^0 * 100)
    await runtime.advance(100);
    // Second retry: 200ms (2^1 * 100)
    await runtime.advance(200);
    await promise;
    expect(attempts).toBe(3);
    expect(logWarns.length).toBe(2);
    expect(logWarns[0]).toContain('retrying in 100ms');
    expect(logWarns[1]).toContain('retrying in 200ms');
  });
});
