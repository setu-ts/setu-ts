import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Room, RoomRegistry } from '../../src/rooms/room-registry.ts';
import { WebSocketConnection } from '../../src/connection/websocket-connection.ts';
import { createFakeTransport, type FakeTransport } from '../fixtures/fake-runtime.ts';

function makeConnection(id: string): { conn: WebSocketConnection; transport: FakeTransport } {
  const transport = createFakeTransport();
  return { conn: new WebSocketConnection(id, '/ws', transport, 0), transport };
}

describe('Room', () => {
  it('reports its name and counts only open members', () => {
    const room = new Room('lobby');
    const a = makeConnection('a');
    const b = makeConnection('b');

    room.add(a.conn);
    room.add(b.conn);
    expect(room.name).toBe('lobby');
    expect(room.size).toBe(2);

    b.conn.close();
    expect(room.size).toBe(1);
    expect(room.rawSize).toBe(2);
  });

  it('broadcasts to every open member', () => {
    const room = new Room('lobby');
    const a = makeConnection('a');
    const b = makeConnection('b');
    room.add(a.conn);
    room.add(b.conn);

    room.broadcast('hello');

    expect(a.transport.sent).toEqual(['hello']);
    expect(b.transport.sent).toEqual(['hello']);
  });

  it('skips the member named by except', () => {
    const room = new Room('lobby');
    const a = makeConnection('a');
    const b = makeConnection('b');
    room.add(a.conn);
    room.add(b.conn);

    room.broadcast('hello', { except: a.conn });

    expect(a.transport.sent).toEqual([]);
    expect(b.transport.sent).toEqual(['hello']);
  });

  it('drops closed members during broadcast rather than growing without bound', () => {
    const room = new Room('lobby');
    const a = makeConnection('a');
    const b = makeConnection('b');
    room.add(a.conn);
    room.add(b.conn);
    b.conn.close();

    room.broadcast('hello');

    expect(a.transport.sent).toEqual(['hello']);
    expect(room.rawSize).toBe(1);
  });

  it('serializes a JSON broadcast once', () => {
    const room = new Room('lobby');
    const a = makeConnection('a');
    const b = makeConnection('b');
    room.add(a.conn);
    room.add(b.conn);

    room.broadcastJson({ type: 'tick', n: 3 }, { except: b.conn });

    expect(a.transport.sent).toEqual(['{"type":"tick","n":3}']);
    expect(b.transport.sent).toEqual([]);
  });

  it('removes a member explicitly', () => {
    const room = new Room('lobby');
    const a = makeConnection('a');
    room.add(a.conn);

    room.remove(a.conn);

    expect(room.rawSize).toBe(0);
  });
});

describe('RoomRegistry', () => {
  it('creates a room on first use and returns the same instance afterwards', () => {
    const registry = new RoomRegistry();

    const first = registry.get('lobby');
    const second = registry.get('lobby');

    expect(first).toBe(second);
    expect(registry.size).toBe(1);
  });

  it('evicts a connection from every room and discards rooms left empty', () => {
    const registry = new RoomRegistry();
    const a = makeConnection('a');
    const b = makeConnection('b');
    registry.get('one').add(a.conn);
    registry.get('two').add(a.conn);
    registry.get('two').add(b.conn);
    expect(registry.size).toBe(2);

    registry.evict(a.conn);

    // "one" held only the evicted connection and is gone; "two" still has b.
    expect(registry.size).toBe(1);
    expect(registry.get('two').rawSize).toBe(1);
  });

  it('clears every room', () => {
    const registry = new RoomRegistry();
    registry.get('one');
    registry.get('two');

    registry.clear();

    expect(registry.size).toBe(0);
  });
});
