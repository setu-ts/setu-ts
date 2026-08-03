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

  it('does not let one rejecting handler stop the others, and reports it', async () => {
    const cron = new WorkersCron({ logger: new RecordingLogger() });
    const logger = new RecordingLogger();
    const withLogger = new WorkersCron({ logger });
    let ran = false;

    withLogger.on('0 * * * *', () => {
      throw new Error('report build failed');
    });
    withLogger.on('0 * * * *', () => {
      ran = true;
    });

    await withLogger.dispatch(firing('0 * * * *'));

    expect(ran).toBe(true);
    expect(logger.messages()).toEqual(['cloudflare-cron: handler failed']);
    expect(logger.records.at(0)?.meta).toMatchObject({
      cron: '0 * * * *',
      error: 'report build failed',
    });
    // The registry with no failing handler stays quiet.
    expect(cron.expressions()).toEqual([]);
  });

  it('reports a non-Error rejection as a string', async () => {
    const logger = new RecordingLogger();
    const cron = new WorkersCron({ logger });
    cron.on('0 * * * *', () => Promise.reject('a bare string'));

    await cron.dispatch(firing('0 * * * *'));

    expect(logger.records.at(0)?.meta).toMatchObject({ error: 'a bare string' });
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

  it('reports an unmatched trigger with what IS registered, and runs nothing', async () => {
    // An expression configured in wrangler.toml with nothing registered here
    // would otherwise fire silently forever.
    const logger = new RecordingLogger();
    const cron = new WorkersCron({ logger });
    let ran = false;
    cron.on('0 * * * *', () => {
      ran = true;
    });

    await cron.dispatch(firing('*/5 * * * *'));

    expect(ran).toBe(false);
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
    // equivalence would silently run the wrong job or none at all.
    const cron = new WorkersCron();
    let ran = false;
    cron.on('0 * * * *', () => {
      ran = true;
    });

    await cron.dispatch(firing('0  *  *  *  *'));
    expect(ran).toBe(false);
  });

  it('is silent on both reporting paths when no logger was supplied', async () => {
    const cron = new WorkersCron();
    cron.on('0 * * * *', () => {
      throw new Error('x');
    });

    await cron.dispatch(firing('0 * * * *'));
    await cron.dispatch(firing('unmatched'));
    // Reaching here without a TypeError is the assertion.
    expect(cron.expressions()).toEqual(['0 * * * *']);
  });
});
