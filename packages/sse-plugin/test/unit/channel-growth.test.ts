import { describe, expect, it, vi } from 'vitest';
import type { HandlerResult, ISseConnection } from '@setu-ts/common';
import { ChannelRegistry } from '../../src/channels/channel-registry.ts';

function connection(id: string): ISseConnection {
  return {
    id,
    isOpen: true,
    lastEventId: null,
    result: {} as HandlerResult,
    send: vi.fn(),
    comment() {},
    close() {},
  };
}

describe('SSE channel reclamation', () => {
  it('reclaims 10,000 per-user channels, including unjoined names and explicit removal', () => {
    const registry = new ChannelRegistry();
    for (let i = 0; i < 10_000; i++) {
      const conn = connection(String(i));
      const handle = registry.get(`user-${i}`);
      handle.add(conn);
      handle.add(conn);
      if (i % 2 === 0) handle.remove(conn);
      else registry.removeFromAll(conn);
      expect(handle.size).toBe(0);
      expect(registry.peek(`user-${i}`)).toBeUndefined();
    }
    registry.get('never-joined');
    expect(registry.peek('never-joined')).toBeUndefined();
    registry.deliverRemote('remote-only', { data: 'ignored' });
    expect(registry.size).toBe(0);
  });

  it('keeps held handles usable after reclamation and clear without echoing remote delivery', () => {
    const forwarded = vi.fn();
    const registry = new ChannelRegistry(forwarded);
    const held = registry.get('room');
    held.publishLocal({ data: 'empty' });
    const first = connection('first');
    held.add(first);
    registry.removeFromAll(first);
    expect(registry.peek('room')).toBeUndefined();
    const next = registry.get('room');
    const second = connection('second');
    next.add(second);
    next.remove(first);
    held.publish({ data: 'new audience' });
    expect(second.send).toHaveBeenCalledWith({ data: 'new audience' });
    expect(first.send).not.toHaveBeenCalled();
    registry.deliverRemote('room', { data: 'remote' });
    expect(forwarded).toHaveBeenCalledExactlyOnceWith('room', { data: 'new audience' });
    registry.clear();
    expect(held.size).toBe(0);
    const third = connection('third');
    held.add(third);
    next.remove(third);
    expect(registry.size).toBe(0);
    held.remove(third);
    registry.removeFromAll(third);
  });

  it("disconnect visits only this connection's joined channels", () => {
    const registry = new ChannelRegistry();
    const target = connection('target');
    for (let i = 0; i < 1_000; i++) registry.get(`other-${i}`).add(connection(`other-${i}`));
    const joined = registry.get('joined');
    joined.add(target);
    const remove = vi.spyOn(Set.prototype, 'delete');
    try {
      registry.removeFromAll(target);
      const attempted = remove.mock.calls.filter(([value]) => value === target).length;
      expect(attempted).toBe(1);
      expect(joined.size).toBe(0);
      expect(registry.size).toBe(1_000);
    } finally {
      remove.mockRestore();
    }
  });
});
