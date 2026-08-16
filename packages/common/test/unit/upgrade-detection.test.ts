/**
 * The WebSocket upgrade predicate and the upgrade-intent brand — both promoted
 * into `common` by M70a so the kernel and the four HTTP adapters share one
 * implementation (the kernel cannot import `@setu-ts/runtime`).
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  isWebSocketUpgradeRequest,
  setUpgradeIntent,
  UPGRADE_INTENT,
  upgradeIntentOf,
} from '../../src/index.ts';
import type { IRequest, WebSocketEventSink } from '../../src/index.ts';

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

const sink: WebSocketEventSink = {
  onOpen: () => {},
  onMessage: () => {},
  onClose: () => {},
  onError: () => {},
};

/** A bare stand-in — only the identity of the object matters to the brand. */
function fakeRequest(): IRequest {
  return { method: 'GET', url: 'http://localhost/ws' } as unknown as IRequest;
}

describe('isWebSocketUpgradeRequest', () => {
  it('accepts the canonical upgrade headers', () => {
    expect(isWebSocketUpgradeRequest(headers({ upgrade: 'websocket', connection: 'Upgrade' })))
      .toBe(true);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(isWebSocketUpgradeRequest(headers({ upgrade: '  WebSocket ', connection: 'UPGRADE' })))
      .toBe(true);
  });

  it('accepts a comma-separated Connection list, as proxies send', () => {
    expect(
      isWebSocketUpgradeRequest(
        headers({ upgrade: 'websocket', connection: 'keep-alive, Upgrade' }),
      ),
    ).toBe(true);
  });

  it('rejects a request with no Upgrade header', () => {
    expect(isWebSocketUpgradeRequest(headers({ connection: 'Upgrade' }))).toBe(false);
  });

  it('rejects an Upgrade header naming another protocol', () => {
    expect(isWebSocketUpgradeRequest(headers({ upgrade: 'h2c', connection: 'Upgrade' })))
      .toBe(false);
  });

  it('rejects a request with no Connection header', () => {
    expect(isWebSocketUpgradeRequest(headers({ upgrade: 'websocket' }))).toBe(false);
  });

  it('rejects a Connection value that merely CONTAINS "upgrade"', () => {
    // The distinction a substring match would lose. `no-upgrade` is not the
    // `upgrade` token, and RFC 6455 §4.2.1 asks for the token.
    expect(isWebSocketUpgradeRequest(headers({ upgrade: 'websocket', connection: 'no-upgrade' })))
      .toBe(false);
  });
});

describe('upgrade intent brand', () => {
  it('reads back what was written', () => {
    const request = fakeRequest();
    setUpgradeIntent(request, { sink, protocol: 'chat' });

    expect(upgradeIntentOf(request)).toEqual({ sink, protocol: 'chat' });
  });

  it('is undefined on a request that was never branded', () => {
    expect(upgradeIntentOf(fakeRequest())).toBeUndefined();
  });

  it('keys on a registered symbol so two copies of common agree', () => {
    // A locally-created `Symbol()` would miss on every read when two copies of
    // this package share a process — the failure M37c hit with hand-written
    // React Router context keys.
    expect(UPGRADE_INTENT).toBe(Symbol.for('setu.upgrade.intent'));
  });

  it('is readable through the raw symbol by a custom adapter', () => {
    const request = fakeRequest();
    setUpgradeIntent(request, { sink });

    const branded = request as IRequest & { [UPGRADE_INTENT]?: unknown };
    expect(branded[UPGRADE_INTENT]).toEqual({ sink });
  });
});
