/**
 * The `inbox` health indicator (M108 §3.11).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createInboxHealthIndicator } from '../../../src/inbox/inbox-health.ts';
import { InboxService } from '../../../src/inbox/inbox-service.ts';
import { FakeInboxStore, inboxRuntime, never, options } from '../../fixtures/inbox.ts';

function harness() {
  const store = new FakeInboxStore();
  const runtime = inboxRuntime();
  const service = new InboxService({ runtime, options: options(), logger: () => undefined });
  return { store, runtime, service, indicator: createInboxHealthIndicator(runtime, service) };
}

describe('inbox health indicator', () => {
  it('is down before activation and after close, reading nothing', async () => {
    const { store, service, indicator } = harness();
    expect(await indicator()).toEqual({ status: 'down', data: { ready: false } });
    service.activate(store);
    service.close();
    expect(await indicator()).toEqual({ status: 'down', data: { ready: false } });
    expect(store.calls).toEqual([]);
  });

  it('is up with no parked rows, degraded with some — counts only', async () => {
    const { store, service, indicator } = harness();
    service.activate(store);
    expect(await indicator()).toEqual({
      status: 'up',
      data: { ready: true, reachable: true, parked: 0, reasons: [] },
    });

    const { store: second, service: other, indicator: fresh } = harness();
    second.stats$ = () => Promise.resolve({ parked: 2 });
    other.activate(second);
    const result = await fresh();
    expect(result).toEqual({
      status: 'degraded',
      data: { ready: true, reachable: true, parked: 2, reasons: ['parked-rows'] },
    });
    expect(JSON.stringify(result)).not.toContain('payroll');
  });

  it('is down when the store rejects, and up/unknown when it does not answer', async () => {
    const rejecting = harness();
    rejecting.store.stats$ = () => Promise.reject(new Error('db down'));
    rejecting.service.activate(rejecting.store);
    expect(await rejecting.indicator()).toEqual({
      status: 'down',
      data: { ready: true, reachable: false },
    });

    const hung = harness();
    hung.store.stats$ = () => never();
    hung.service.activate(hung.store);
    expect(await hung.indicator()).toEqual({
      status: 'up',
      data: { ready: true, reachable: 'unknown' },
    });
  });

  it('reports unreachable when the inbox closes between the check and the read', async () => {
    const { store, service, indicator } = harness();
    service.activate(store);
    let calls = 0;
    // `activeStore` is read twice: by the gate, then by the probe.
    const original = service.activeStore.bind(service);
    service.activeStore = () => (++calls === 1 ? original() : undefined);
    expect(await indicator()).toEqual({ status: 'down', data: { ready: true, reachable: false } });
  });
});
