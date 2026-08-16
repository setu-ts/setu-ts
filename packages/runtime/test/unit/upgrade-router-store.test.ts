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

describe('UpgradeRouterStore', () => {
  it('starts with no router installed', () => {
    expect(new UpgradeRouterStore().hasRouter).toBe(false);
  });

  it('reports a router once one is installed', () => {
    const store = new UpgradeRouterStore();
    store.set(() => Promise.resolve({ accept: true, sink }));

    // `hasRouter` is the only thing an adapter still reads: Node attaches its
    // raw `upgrade` listener only when a router exists, so a plain HTTP
    // application never loads `ws`. The routing decision itself moved to the
    // kernel in M70a, after the middleware pipeline.
    expect(store.hasRouter).toBe(true);
  });

  it('replaces a previously installed router', () => {
    const store = new UpgradeRouterStore();
    store.set(() => Promise.resolve({ accept: false, status: 400 }));
    store.set(() => Promise.resolve({ accept: false, status: 503 }));

    expect(store.hasRouter).toBe(true);
  });
});
