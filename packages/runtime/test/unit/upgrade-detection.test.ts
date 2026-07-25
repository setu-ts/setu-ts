import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { isWebSocketUpgradeRequest } from '../../src/adapters/shared/upgrade-detection.ts';

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe('isWebSocketUpgradeRequest', () => {
  it('accepts the canonical header pair', () => {
    expect(isWebSocketUpgradeRequest(headers({ upgrade: 'websocket', connection: 'Upgrade' })))
      .toBe(true);
  });

  it('is case-insensitive on both header values', () => {
    expect(isWebSocketUpgradeRequest(headers({ upgrade: 'WebSocket', connection: 'UPGRADE' })))
      .toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isWebSocketUpgradeRequest(headers({ upgrade: ' websocket ', connection: ' upgrade ' })))
      .toBe(true);
  });

  it('accepts a multi-token Connection header, as proxies send', () => {
    expect(
      isWebSocketUpgradeRequest(
        headers({ upgrade: 'websocket', connection: 'keep-alive, Upgrade' }),
      ),
    ).toBe(true);
  });

  it('rejects a request with no Upgrade header', () => {
    expect(isWebSocketUpgradeRequest(headers({ connection: 'Upgrade' }))).toBe(false);
  });

  it('rejects a non-websocket upgrade protocol', () => {
    expect(isWebSocketUpgradeRequest(headers({ upgrade: 'h2c', connection: 'Upgrade' })))
      .toBe(false);
  });

  it('rejects when the Connection header is absent', () => {
    expect(isWebSocketUpgradeRequest(headers({ upgrade: 'websocket' }))).toBe(false);
  });

  it('rejects when Connection does not contain the upgrade token', () => {
    expect(isWebSocketUpgradeRequest(headers({ upgrade: 'websocket', connection: 'keep-alive' })))
      .toBe(false);
  });

  it('rejects a Connection value that merely contains upgrade as a substring', () => {
    expect(
      isWebSocketUpgradeRequest(headers({ upgrade: 'websocket', connection: 'upgrade-insecure' })),
    ).toBe(false);
  });

  it('rejects an ordinary request', () => {
    expect(isWebSocketUpgradeRequest(headers({ accept: 'text/html' }))).toBe(false);
  });
});
