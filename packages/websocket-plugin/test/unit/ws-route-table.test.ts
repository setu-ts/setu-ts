import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  parseRequestedProtocols,
  selectProtocol,
  WsRouteTable,
} from '../../src/routing/ws-route-table.ts';
import { upgradeRequest } from '../fixtures/fake-runtime.ts';

describe('parseRequestedProtocols', () => {
  it('returns nothing when the header is absent', () => {
    expect(parseRequestedProtocols(null)).toEqual([]);
  });

  it('splits and trims a comma-separated list', () => {
    expect(parseRequestedProtocols('chat, superchat ,  json')).toEqual([
      'chat',
      'superchat',
      'json',
    ]);
  });

  it('drops empty tokens', () => {
    expect(parseRequestedProtocols('chat,,  ,json')).toEqual(['chat', 'json']);
  });
});

describe('selectProtocol', () => {
  it('negotiates nothing when the route configures no protocols', () => {
    expect(selectProtocol([], ['chat'])).toBeUndefined();
  });

  it('picks the client first preference that the route accepts', () => {
    expect(selectProtocol(['json', 'chat'], ['chat', 'json'])).toBe('chat');
  });

  it('refuses when no requested protocol is accepted', () => {
    expect(selectProtocol(['json'], ['chat'])).toBe(false);
  });

  it('refuses when the route requires a protocol and the client requested none', () => {
    expect(selectProtocol(['json'], [])).toBe(false);
  });
});

describe('WsRouteTable', () => {
  it('matches a registered path exactly', () => {
    const table = new WsRouteTable();
    table.add('/ws/chat', {});

    const match = table.match(upgradeRequest('http://localhost/ws/chat'));

    expect(match).not.toBeNull();
    expect(match?.matched).toBe(true);
    expect(match?.matched === true && match.route.path).toBe('/ws/chat');
    expect(table.size).toBe(1);
  });

  it('ignores the query string when matching', () => {
    const table = new WsRouteTable();
    table.add('/ws/chat', {});

    const match = table.match(upgradeRequest('http://localhost/ws/chat?room=general&x=1'));

    expect(match?.matched).toBe(true);
  });

  it('returns null for an unregistered path so the adapter falls through', () => {
    const table = new WsRouteTable();
    table.add('/ws/chat', {});

    expect(table.match(upgradeRequest('http://localhost/ws/other'))).toBeNull();
    expect(table.match(upgradeRequest('http://localhost/ws/chat/nested'))).toBeNull();
  });

  it('rejects a duplicate path registration', () => {
    const table = new WsRouteTable();
    table.add('/ws/chat', {});

    expect(() => table.add('/ws/chat', {})).toThrow('already registered');
  });

  it('echoes a negotiated subprotocol when the client requests an accepted one', () => {
    const table = new WsRouteTable();
    table.add('/ws', {}, { protocols: ['chat', 'json'] });

    const match = table.match(
      upgradeRequest('http://localhost/ws', { 'sec-websocket-protocol': 'json, chat' }),
    );

    expect(match?.matched).toBe(true);
    expect(match?.matched === true && match.protocol).toBe('json');
  });

  it('refuses with 400 when the requested subprotocol is not accepted', () => {
    const table = new WsRouteTable();
    table.add('/ws', {}, { protocols: ['chat'] });

    const match = table.match(
      upgradeRequest('http://localhost/ws', { 'sec-websocket-protocol': 'binary' }),
    );

    expect(match).toEqual({ matched: false, status: 400 });
  });

  it('echoes no protocol when the route configures none, even if the client asks', () => {
    const table = new WsRouteTable();
    table.add('/ws', {});

    const match = table.match(
      upgradeRequest('http://localhost/ws', { 'sec-websocket-protocol': 'chat' }),
    );

    expect(match?.matched).toBe(true);
    expect(match?.matched === true && match.protocol).toBeUndefined();
  });
});
