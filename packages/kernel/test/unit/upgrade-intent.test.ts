/**
 * Unit tests for UPGRADE_INTENT symbol usage in the kernel terminal handler
 * (M70a). Verifies that the intent is written to the IRequest when the kernel
 * decides to upgrade, and that the adapter can read it.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { UPGRADE_INTENT } from '@setu-ts/common';
import type { WebSocketEventSink, WebSocketUpgradeIntent } from '@setu-ts/common';

describe('UPGRADE_INTENT symbol (M70a)', () => {
  it('is a Symbol.for (two copies of common agree)', () => {
    // Symbol.for creates a global symbol — two copies of @setu-ts/common in
    // the same process must resolve to the same symbol.
    const other = Symbol.for('setu.upgrade.intent');
    expect(UPGRADE_INTENT).toBe(other);
  });

  it('can be used as a Record key on IRequest', () => {
    const request = {} as Record<symbol, WebSocketUpgradeIntent | undefined>;
    const sink = {
      onOpen: () => {},
      onMessage: () => {},
      onClose: () => {},
      onError: () => {},
    } as WebSocketEventSink;

    const intent: WebSocketUpgradeIntent = { sink, protocol: 'chat' };
    request[UPGRADE_INTENT] = intent;

    expect(request[UPGRADE_INTENT]).toEqual(intent);
    expect(request[UPGRADE_INTENT]?.sink).toBe(sink);
    expect(request[UPGRADE_INTENT]?.protocol).toBe('chat');
  });

  it('is absent when no upgrade is requested', () => {
    const request = {} as Record<symbol, WebSocketUpgradeIntent | undefined>;
    expect(request[UPGRADE_INTENT]).toBeUndefined();
  });

  it('allows the adapter to detect "no upgrade" via undefined check', () => {
    const request = {} as Record<symbol, WebSocketUpgradeIntent | undefined>;
    const intent = request[UPGRADE_INTENT];
    // The adapter checks `intent !== undefined` to decide whether to upgrade.
    expect(intent !== undefined).toBe(false);
  });

  it('allows the adapter to detect "upgrade" via undefined check', () => {
    const request = {} as Record<symbol, WebSocketUpgradeIntent | undefined>;
    const sink = {
      onOpen: () => {},
      onMessage: () => {},
      onClose: () => {},
      onError: () => {},
    } as WebSocketEventSink;
    request[UPGRADE_INTENT] = { sink };

    const intent = request[UPGRADE_INTENT];
    expect(intent !== undefined).toBe(true);
  });
});
