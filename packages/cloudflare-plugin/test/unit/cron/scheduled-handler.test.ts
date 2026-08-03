/**
 * The `scheduled` export is a thin adapter, and the one property that matters
 * is that it AWAITS: Cloudflare ends the invocation when the returned promise
 * settles, so returning early truncates the work.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createScheduledHandler } from '../../../src/cron/scheduled-handler.ts';
import { WorkersCron } from '../../../src/cron/workers-cron.ts';

describe('createScheduledHandler', () => {
  it('dispatches into the registry it was given', async () => {
    const cron = new WorkersCron();
    const seen: string[] = [];
    cron.on('0 * * * *', (controller) => {
      seen.push(controller.cron);
    });

    await createScheduledHandler(cron)({ cron: '0 * * * *', scheduledTime: 1 });

    expect(seen).toEqual(['0 * * * *']);
  });

  it('does not resolve until every handler has finished', async () => {
    const cron = new WorkersCron();
    let finished = false;
    cron.on('0 * * * *', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = true;
    });

    const handler = createScheduledHandler(cron);
    const pending = handler({ cron: '0 * * * *', scheduledTime: 1 });

    // Not yet — proving the assertion below is not vacuously true.
    expect(finished).toBe(false);
    await pending;
    expect(finished).toBe(true);
  });

  it('resolves for an unmatched expression rather than rejecting', async () => {
    // A trigger with no handler is a configuration gap the registry reports;
    // throwing would additionally mark the whole invocation failed.
    const handler = createScheduledHandler(new WorkersCron());

    await expect(handler({ cron: '0 * * * *', scheduledTime: 1 })).resolves.toBeUndefined();
  });
});
