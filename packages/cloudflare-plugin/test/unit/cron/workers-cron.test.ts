/**
 * The cron registry keys on the expression string, because that is the only
 * thing `ScheduledController` reports. A registration that does not match the
 * `wrangler.toml` trigger never fires, so the unmatched path must be loud.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { WorkersCron } from '../../../src/cron/workers-cron.ts';
import type { IScheduledController } from '../../../src/bindings/facades.ts';
import { RecordingLogger } from '../../fakes.ts';

/** A firing trigger. */
function firing(cron: string, scheduledTime = 1_700_000_000_000): IScheduledController {
  return { cron, scheduledTime };
}

describe('WorkersCron.on', () => {
  it('lists every registered expression, so an app can check its wrangler.toml', () => {
    const cron = new WorkersCron();
    cron.on('0 * * * *', () => {});
    cron.on('*/5 * * * *', () => {});

    expect(cron.expressions()).toEqual(['0 * * * *', '*/5 * * * *']);
  });

  it('lists an expression once however many handlers share it', () => {
    const cron = new WorkersCron();
    cron.on('0 * * * *', () => {});
    cron.on('0 * * * *', () => {});

    expect(cron.expressions()).toEqual(['0 * * * *']);
  });

  it('returns itself so registrations chain', () => {
    const cron = new WorkersCron();
    expect(cron.on('0 * * * *', () => {})).toBe(cron);
  });
});

describe('WorkersCron.dispatch', () => {
  it('runs only the handlers registered for the firing expression', async () => {
    const cron = new WorkersCron();
    const ran: string[] = [];

    cron.on('0 * * * *', () => {
      ran.push('hourly');
    });
    cron.on('0 3 * * *', () => {
      ran.push('nightly');
    });

    await cron.dispatch(firing('0 3 * * *'));

    expect(ran).toEqual(['nightly']);
  });

  it('forwards the controller unchanged to the handler', async () => {
    const cron = new WorkersCron();
    const seen: IScheduledController[] = [];
    cron.on('0 * * * *', (controller) => {
      seen.push(controller);
    });

    await cron.dispatch(firing('0 * * * *', 1_234));

    expect(seen).toEqual([{ cron: '0 * * * *', scheduledTime: 1_234 }]);
  });

  it('runs every handler sharing an expression', async () => {
    const cron = new WorkersCron();
    const ran: string[] = [];

    cron.on('0 * * * *', () => {
      ran.push('a');
    });
    cron.on('0 * * * *', () => {
      ran.push('b');
    });

    await cron.dispatch(firing('0 * * * *'));
    expect(ran.sort()).toEqual(['a', 'b']);
  });

  it('does not let one rejecting handler stop the others, reports it, then fails the invocation', async () => {
    const logger = new RecordingLogger();
    const withLogger = new WorkersCron({ logger });
    const ran: string[] = [];

    withLogger.on('0 * * * *', () => {
      throw new Error('report build failed');
    });
    withLogger.on('0 * * * *', () => {
      ran.push('healthy');
    });

    const failure = await withLogger.dispatch(firing('0 * * * *')).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(ran).toEqual(['healthy']);
    // M70l X9-5: the rejection reaches the platform AFTER every handler has
    // settled — the platform counting the invocation failed is the sink that
    // needs no logger configuration.
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors;
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('report build failed');
    expect(logger.messages()).toEqual(['cloudflare-cron: handler failed']);
    expect(logger.records.at(0)?.meta).toMatchObject({
      cron: '0 * * * *',
      error: 'report build failed',
    });
  });

  it('aggregates EVERY handler failure, not only the first', async () => {
    const cron = new WorkersCron();
    cron.on('0 * * * *', () => {
      throw new Error('first');
    });
    cron.on('0 * * * *', () => {
      throw new Error('second');
    });

    const failure = await cron.dispatch(firing('0 * * * *')).then(
      () => undefined,
      (error: unknown) => error,
    );

    const messages = (failure as AggregateError).errors.map((e) => (e as Error).message);
    expect(messages.sort()).toEqual(['first', 'second']);
  });

  it('reports a non-Error rejection as a string, then rejects with an Error', async () => {
    const logger = new RecordingLogger();
    const cron = new WorkersCron({ logger });
    cron.on('0 * * * *', () => Promise.reject('a bare string'));

    const failure = await cron.dispatch(firing('0 * * * *')).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(logger.records.at(0)?.meta).toMatchObject({ error: 'a bare string' });
    // Coerced so `instanceof` checks by consumers stay meaningful.
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBeInstanceOf(Error);
  });

  it('awaits a slow handler, so the invocation stays alive until it finishes', async () => {
    const cron = new WorkersCron();
    let finished = false;

    cron.on('0 * * * *', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = true;
    });

    await cron.dispatch(firing('0 * * * *'));

    expect(finished).toBe(true);
  });

  it('reports an unmatched trigger with what IS registered, runs nothing, and fails the invocation', async () => {
    // An expression configured in wrangler.toml with nothing registered here
    // would otherwise fire silently forever. The report needs a logger; the
    // failure does not (M70l X9-5).
    const logger = new RecordingLogger();
    const cron = new WorkersCron({ logger });
    let ran = false;
    cron.on('0 * * * *', () => {
      ran = true;
    });

    const failure = await cron.dispatch(firing('*/5 * * * *')).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(ran).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('*/5 * * * *');
    expect(logger.messages()).toEqual([
      'cloudflare-cron: trigger fired with no handler registered',
    ]);
    expect(logger.records.at(0)?.meta).toMatchObject({
      cron: '*/5 * * * *',
      registered: ['0 * * * *'],
    });
  });

  it('matches the expression EXACTLY — whitespace is not normalized', async () => {
    // wrangler.toml is the source of truth for the string, so guessing at
    // equivalence would silently run the wrong job or none at all. The
    // whitespace variant has no handler, so dispatch also rejects (M70l).
    const cron = new WorkersCron();
    let ran = false;
    cron.on('0 * * * *', () => {
      ran = true;
    });

    await expect(cron.dispatch(firing('0  *  *  *  *'))).rejects.toThrow(
      /no handler registered/,
    );
    expect(ran).toBe(false);
  });

  it('rejects on both failure paths even when no logger was supplied', async () => {
    const cron = new WorkersCron();
    cron.on('0 * * * *', () => {
      throw new Error('x');
    });

    const handlerFailure = await cron.dispatch(firing('0 * * * *')).then(
      () => undefined,
      (error: unknown) => error,
    );
    const unmatchedFailure = await cron.dispatch(firing('unmatched')).then(
      () => undefined,
      (error: unknown) => error,
    );
    // No logger: nothing was REPORTED, but both paths still FAIL loudly —
    // the platform's own invocation-failed signal needs no configuration.
    expect(handlerFailure).toBeInstanceOf(AggregateError);
    expect(unmatchedFailure).toBeInstanceOf(Error);
  });
});
