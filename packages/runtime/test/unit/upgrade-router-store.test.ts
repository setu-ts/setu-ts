import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { WebSocketEventSink } from '@setu-ts/common';
import { UpgradeRouterStore } from '../../src/adapters/shared/upgrade-router-store.ts';

const sink: WebSocketEventSink = {
  onOpen: () => {},
  onMessage: () => {},
  onClose: () => {},
  onError: () => {},
};

function upgradeRequest(url = 'http://localhost/ws'): Request {
  return new Request(url, { headers: { upgrade: 'websocket', connection: 'Upgrade' } });
}

describe('UpgradeRouterStore', () => {
  it('starts with no router installed', () => {
    expect(new UpgradeRouterStore().hasRouter).toBe(false);
  });

  it('falls through when no router is installed', async () => {
    const store = new UpgradeRouterStore();

    expect(await store.consult(upgradeRequest())).toBeNull();
  });

  it('returns the router decision for an upgrade request', async () => {
    const store = new UpgradeRouterStore();
    store.set(() => Promise.resolve({ accept: true, sink }));

    const decision = await store.consult(upgradeRequest());

    expect(decision).toEqual({ accept: true, sink });
    expect(store.hasRouter).toBe(true);
  });

  it('returns a rejection unchanged', async () => {
    const store = new UpgradeRouterStore();
    store.set(() => Promise.resolve({ accept: false, status: 503 }));

    expect(await store.consult(upgradeRequest())).toEqual({ accept: false, status: 503 });
  });

  it('never consults the router for a non-upgrade request', async () => {
    const store = new UpgradeRouterStore();
    let calls = 0;
    store.set(() => {
      calls++;
      return Promise.resolve({ accept: true, sink });
    });

    const decision = await store.consult(new Request('http://localhost/ws'));

    expect(decision).toBeNull();
    expect(calls).toBe(0);
  });

  it('passes a router null through as a fall-through', async () => {
    const store = new UpgradeRouterStore();
    store.set(() => Promise.resolve(null));

    expect(await store.consult(upgradeRequest())).toBeNull();
  });

  it('converts a throwing router into a 500 refusal rather than crashing the serve loop', async () => {
    const store = new UpgradeRouterStore();
    store.set(() => {
      throw new Error('route selection blew up');
    });

    expect(await store.consult(upgradeRequest())).toEqual({ accept: false, status: 500 });
  });

  it('converts a rejecting router into a 500 refusal', async () => {
    const store = new UpgradeRouterStore();
    store.set(() => Promise.reject(new Error('async failure')));

    expect(await store.consult(upgradeRequest())).toEqual({ accept: false, status: 500 });
  });

  it('replaces a previously installed router', async () => {
    const store = new UpgradeRouterStore();
    store.set(() => Promise.resolve({ accept: false, status: 400 }));
    store.set(() => Promise.resolve({ accept: false, status: 503 }));

    expect(await store.consult(upgradeRequest())).toEqual({ accept: false, status: 503 });
  });
});
