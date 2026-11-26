import { describe, expect, it, vi } from 'vitest';
import { FrameAge } from '../../src/transports/frame-age.ts';

const frame = { kind: 'ws-room', origin: 'a', name: 'room', data: 'payload-canary' } as const;

describe('frame timestamp and receiver age limit', () => {
  it('stamps even with the default disabled filter, without mutating the frame', () => {
    const policy = new FrameAge(0, () => 10000);
    expect(policy.stamp(frame)).toEqual({ ...frame, sentAtMs: 10000 });
    expect(frame).not.toHaveProperty('sentAtMs');
    expect(policy.receive({ ...frame, sentAtMs: 1 })).toEqual(frame);
  });
  it.each([NaN, Infinity, -1, 2147483648])('refuses invalid maxFrameAgeMs %s', (max) => {
    expect(() => new FrameAge(max)).toThrow('maxFrameAgeMs');
  });
  it('delivers at the threshold, drops above it, and reports each transition once', () => {
    const warn = vi.fn();
    const policy = new FrameAge(100, () => 1000, warn);
    expect(policy.receive({ ...frame, sentAtMs: 900 })).toEqual(frame);
    expect(policy.receive({ ...frame, sentAtMs: 899 })).toBeNull();
    expect(policy.receive({ ...frame, sentAtMs: 1 })).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(policy.receive({ ...frame, sentAtMs: 901 })).toEqual(frame);
    expect(policy.receive(frame)).toEqual(frame);
    expect(warn.mock.calls).toEqual([
      [
        "realtime-backplane dropping frames older than 100 ms; dropped 1; the oldest was 101 ms; check the broker and the replicas' clocks",
      ],
      [
        "realtime-backplane accepting frames again; dropped 2; the oldest was 999 ms; check the broker and the replicas' clocks",
      ],
    ]);
    expect(policy.receive({ ...frame, sentAtMs: 0 })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('payload-canary');
  });
  it.each([undefined, null, NaN, Infinity, '0', {}, 2000])(
    'delivers compatible or future timestamp %j and strips it',
    (sentAtMs) => {
      const policy = new FrameAge(100, () => 1000);
      expect(policy.receive({ ...frame, sentAtMs })).toEqual(frame);
    },
  );
  it('without a clock stamps nothing and warns only when filtering was requested', () => {
    const warn = vi.fn();
    const disabled = new FrameAge(0, undefined, warn);
    expect(disabled.stamp(frame)).toBe(frame);
    expect(warn).not.toHaveBeenCalled();
    const enabled = new FrameAge(1, undefined, warn);
    expect(enabled.stamp(frame)).toBe(frame);
    expect(enabled.receive({ ...frame, sentAtMs: 0 })).toEqual(frame);
    expect(warn).toHaveBeenCalledOnce();
    expect(
      () =>
        new FrameAge(1, undefined, () => {
          throw 1;
        }),
    ).not.toThrow();
  });
  it('reports uncertainty, mentioning dropping only with the option on', () => {
    const warn = vi.fn();
    const defaultPolicy = new FrameAge(0, () => 0, warn);
    defaultPolicy.publishFailed(false);
    expect(warn).not.toHaveBeenCalled();
    defaultPolicy.publishFailed(true);
    defaultPolicy.publishFailed(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toBe(
      'realtime-backplane publish failed; the frame may still arrive late',
    );
    defaultPolicy.publishSucceeded();
    defaultPolicy.publishFailed(true);
    expect(warn).toHaveBeenCalledTimes(2);
    new FrameAge(100, () => 0, warn).publishFailed(true);
    expect(warn.mock.calls[2]![0]).toContain(
      'receivers configured with maxFrameAgeMs drop frames older than 100 ms',
    );
  });
});
