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

  it('keeps broadcasting when one peer send throws, and drops that peer', () => {
    const room = new Room('lobby');
    const a = makeConnection('a');
    const bad = makeConnection('bad');
    const c = makeConnection('c');
    // A transport that reports open but fails on write — a peer whose socket
    // died without a close event yet.
    bad.transport.send = () => {
      throw new Error('socket write failed');
    };
    room.add(a.conn);
    room.add(bad.conn);
    room.add(c.conn);

    expect(() => room.broadcast('hello')).not.toThrow();

    // The peer after the failing one still received it.
    expect(a.transport.sent).toEqual(['hello']);
    expect(c.transport.sent).toEqual(['hello']);
    expect(room.rawSize).toBe(2);
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

  it('touches only the rooms the connection actually joined', () => {
    // The regression guard for the O(rooms) scan: eviction must not reach into
    // rooms the peer was never in. Before the reverse index every room on the
    // server was visited on every single disconnect.
    const registry = new RoomRegistry();
    const a = makeConnection('a');
    const b = makeConnection('b');
    registry.get('joined').add(a.conn);

    const untouched = registry.get('untouched');
    untouched.add(b.conn);
    let removeCalls = 0;
    const realRemove = untouched.remove.bind(untouched);
    untouched.remove = (conn) => {
      removeCalls++;
      realRemove(conn);
    };

    registry.evict(a.conn);

    expect(removeCalls).toBe(0);
    expect(registry.get('untouched').rawSize).toBe(1);
  });

  it('evicts a connection that belongs to no room without touching anything', () => {
    const registry = new RoomRegistry();
    const a = makeConnection('a');
    const b = makeConnection('b');
    registry.get('lobby').add(b.conn);

    registry.evict(a.conn);

    expect(registry.size).toBe(1);
    expect(registry.get('lobby').rawSize).toBe(1);
  });

  it('stops tracking a connection once it has left every room', () => {
    const registry = new RoomRegistry();
    const a = makeConnection('a');
    registry.get('one').add(a.conn);
    registry.get('two').add(a.conn);

    registry.get('one').remove(a.conn);
    registry.get('two').remove(a.conn);

    // Both rooms emptied, so both are gone and the reverse index holds nothing.
    expect(registry.size).toBe(0);
    // A second eviction is a no-op rather than a resurrection.
    registry.evict(a.conn);
    expect(registry.size).toBe(0);
  });

  it('discards a room emptied by a mid-broadcast drop', () => {
    // The drop happens inside broadcast, not through evict — the reverse index
    // and the room map both have to notice it.
    const registry = new RoomRegistry();
    const a = makeConnection('a');
    registry.get('lobby').add(a.conn);
    a.conn.close();

    registry.get('lobby').broadcast('hello');

    expect(registry.size).toBe(0);
  });

  it('counts a repeated add once, so one removal really empties the room', () => {
    const registry = new RoomRegistry();
    const a = makeConnection('a');
    registry.get('lobby').add(a.conn);
    registry.get('lobby').add(a.conn);

    expect(registry.get('lobby').rawSize).toBe(1);

    registry.evict(a.conn);

    expect(registry.size).toBe(0);
  });

  it('keeps a rebound room when a stale one empties under the same name', () => {
    const registry = new RoomRegistry();
    const a = makeConnection('a');
    const b = makeConnection('b');
    const stale = registry.get('lobby');
    stale.add(a.conn);

    // clear() unbinds the name while application code still holds `stale`.
    registry.clear();
    const fresh = registry.get('lobby');
    fresh.add(b.conn);
    expect(fresh).not.toBe(stale);

    // The orphan emptying must not delete the live binding under that name.
    stale.remove(a.conn);

    expect(registry.get('lobby')).toBe(fresh);
    expect(registry.get('lobby').rawSize).toBe(1);
  });
});

describe('Room membership listener', () => {
  it('reports joins and leaves exactly once each', () => {
    const events: string[] = [];
    const room = new Room('lobby', {
      onJoin: (conn) => events.push(`join:${conn.id}`),
      onLeave: (conn) => events.push(`leave:${conn.id}`),
    });
    const a = makeConnection('a');

    room.add(a.conn);
    room.add(a.conn); // duplicate — must not re-report
    room.remove(a.conn);
    room.remove(a.conn); // already gone — must not re-report

    expect(events).toEqual(['join:a', 'leave:a']);
  });

  it('reports a leave for a peer dropped mid-broadcast', () => {
    const events: string[] = [];
    const room = new Room('lobby', {
      onJoin: () => {},
      onLeave: (conn) => events.push(`leave:${conn.id}`),
    });
    const open = makeConnection('open');
    const closed = makeConnection('closed');
    const unwritable = makeConnection('unwritable');
    unwritable.transport.send = () => {
      throw new Error('socket write failed');
    };
    room.add(open.conn);
    room.add(closed.conn);
    room.add(unwritable.conn);
    closed.conn.close();

    room.broadcast('hello');

    expect(events).toEqual(['leave:closed', 'leave:unwritable']);
    expect(room.rawSize).toBe(1);
  });
});
