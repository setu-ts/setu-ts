/**
 * Unit tests for ChannelRegistry and SseChannelImpl.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { HandlerResult, ISseConnection, SseMessage } from '@hono-enterprise/common';
import { ChannelRegistry } from '../../src/channels/channel-registry.ts';
import { SseChannelImpl } from '../../src/channels/channel-registry.ts';

function makeFakeConn(id: string): ISseConnection {
  let open = true;
  return {
    get id() {
      return id;
    },
    get lastEventId() {
      return null;
    },
    get isOpen() {
      return open;
    },
    get result(): HandlerResult {
      return undefined as unknown as HandlerResult;
    },
    send(_msg: SseMessage) {},
    comment(_text: string) {},
    close() {
      open = false;
    },
  };
}

describe('SseChannelImpl', () => {
  it('should have size 0 initially', () => {
    const channel = new SseChannelImpl();
    expect(channel.size).toBe(0);
  });

  it('should increase size on add', () => {
    const channel = new SseChannelImpl();
    const conn = makeFakeConn('1');
    channel.add(conn);
    expect(channel.size).toBe(1);
  });

  it('should decrease size on remove', () => {
    const channel = new SseChannelImpl();
    const conn = makeFakeConn('1');
    channel.add(conn);
    channel.remove(conn);
    expect(channel.size).toBe(0);
  });

  it('should publish to open members', () => {
    const channel = new SseChannelImpl();
    const conn1 = makeFakeConn('1');
    const conn2 = makeFakeConn('2');
    let sent1 = false;
    let sent2 = false;
    conn1.send = () => {
      sent1 = true;
    };
    conn2.send = () => {
      sent2 = true;
    };
    channel.add(conn1);
    channel.add(conn2);
    channel.publish({ data: 'hello' });
    expect(sent1).toBe(true);
    expect(sent2).toBe(true);
  });

  it('should skip closed members during publish', () => {
    const channel = new SseChannelImpl();
    const conn = makeFakeConn('1');
    let sent = false;
    conn.send = () => {
      sent = true;
    };
    channel.add(conn);
    // Close the connection using its own close() method.
    conn.close();
    // Now publish — closed member should be skipped.
    channel.publish({ data: 'hello' });
    expect(sent).toBe(false);
  });

  it('should not throw if a send method throws', () => {
    const channel = new SseChannelImpl();
    const conn = makeFakeConn('1');
    conn.send = () => {
      throw new Error('boom');
    };
    channel.add(conn);
    // Should not throw.
    expect(() => channel.publish({ data: 'hello' })).not.toThrow();
  });
});

describe('ChannelRegistry', () => {
  it('should have 0 channels initially', () => {
    const registry = new ChannelRegistry();
    expect(registry.size).toBe(0);
  });

  it('should create a channel on get', () => {
    const registry = new ChannelRegistry();
    registry.get('room');
    expect(registry.size).toBe(1);
  });

  it('should return the same channel on repeated get', () => {
    const registry = new ChannelRegistry();
    const ch1 = registry.get('room');
    const ch2 = registry.get('room');
    expect(ch1).toBe(ch2);
  });

  it('should create separate channels for different names', () => {
    const registry = new ChannelRegistry();
    const ch1 = registry.get('room1');
    const ch2 = registry.get('room2');
    expect(ch1).not.toBe(ch2);
    expect(registry.size).toBe(2);
  });

  it('should removeFromAll prune a connection from every channel', () => {
    const registry = new ChannelRegistry();
    const ch1 = registry.get('room1');
    const ch2 = registry.get('room2');
    const conn = makeFakeConn('1');
    ch1.add(conn);
    ch2.add(conn);
    expect(ch1.size).toBe(1);
    expect(ch2.size).toBe(1);
    registry.removeFromAll(conn);
    expect(ch1.size).toBe(0);
    expect(ch2.size).toBe(0);
  });

  it('should clear all channels', () => {
    const registry = new ChannelRegistry();
    registry.get('room1');
    registry.get('room2');
    expect(registry.size).toBe(2);
    registry.clear();
    expect(registry.size).toBe(0);
  });
});
