import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as barrel from '../../src/index.ts';

describe('package barrel', () => {
  it('exports every documented value', () => {
    expect(typeof barrel.WebSocketPlugin).toBe('function');
    expect(typeof barrel.WebSocketService).toBe('function');
    expect(typeof barrel.WebSocketConnection).toBe('function');
    expect(typeof barrel.Room).toBe('function');
    expect(typeof barrel.RoomRegistry).toBe('function');
    expect(typeof barrel.WsRouteTable).toBe('function');
    expect(typeof barrel.HeartbeatSweeper).toBe('function');
    expect(typeof barrel.WebSocketUnavailableError).toBe('function');
    expect(typeof barrel.resolveOptions).toBe('function');
    expect(typeof barrel.frameByteLength).toBe('function');
    expect(typeof barrel.buildContext).toBe('function');
    expect(typeof barrel.parseRequestedProtocols).toBe('function');
    expect(typeof barrel.selectProtocol).toBe('function');
  });

  it('re-exports the capability token constant', () => {
    expect(barrel.CAPABILITIES.WEBSOCKET).toBe('websocket');
  });
});

describe('WebSocketUnavailableError', () => {
  it('carries a name and a default explanation naming the missing seam', () => {
    const error = new barrel.WebSocketUnavailableError();

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('WebSocketUnavailableError');
    expect(error.message).toContain('setUpgradeRouter');
  });

  it('accepts a caller-supplied message', () => {
    expect(new barrel.WebSocketUnavailableError('custom reason').message).toBe('custom reason');
  });
});
