import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { createRealtimeHandlerErrorReporter, dispatchRealtimeFrame } from '../../src/index.ts';
import type { RealtimeFrame, RealtimeFrameHandler } from '../../src/index.ts';

const FRAME: RealtimeFrame = { kind: 'ws-room', name: 'room', origin: 'peer', data: 'secret' };

describe('shared realtime dispatch', () => {
  it('isolates synchronous throws, reports successes and snapshots handlers', () => {
    const failed = vi.fn();
    const succeeded = vi.fn();
    const second = vi.fn();
    const late = vi.fn();
    const error = new Error('sync');
    const handlers = new Set<RealtimeFrameHandler>();
    const first = (): void => {
      handlers.delete(second);
      handlers.add(late);
      throw error;
    };
    handlers.add(first);
    handlers.add(second);
    expect(dispatchRealtimeFrame(handlers, FRAME, { failed, succeeded })).toBe(false);
    expect(failed).toHaveBeenCalledWith(first, error, FRAME);
    expect(second).toHaveBeenCalledWith(FRAME);
    expect(succeeded).toHaveBeenCalledWith(second);
    expect(late).not.toHaveBeenCalled();
    expect(dispatchRealtimeFrame([], FRAME, { failed, succeeded })).toBe(true);
  });

  it('captures async rejection without unhandledRejection and reports fulfilment', async () => {
    const unhandled: unknown[] = [];
    const listener = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', listener);
    try {
      const failed = vi.fn();
      const succeeded = vi.fn();
      const error = new Error('async');
      const bad = async (): Promise<void> => {
        await Promise.resolve();
        throw error;
      };
      const good = async (): Promise<void> => {};
      expect(dispatchRealtimeFrame([bad, good], FRAME, { failed, succeeded })).toBe(true);
      expect(failed).not.toHaveBeenCalled();
      await setImmediate();
      expect(unhandled).toEqual([]);
      expect(failed).toHaveBeenCalledExactlyOnceWith(bad, error, FRAME);
      expect(succeeded).toHaveBeenCalledExactlyOnceWith(good);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('assimilates thenables and treats a throwing then getter as a synchronous failure', async () => {
    const failed = vi.fn();
    const succeeded = vi.fn();
    const error = new Error('then');
    const thenable = () => ({
      then: (_resolve: unknown, reject: (error: unknown) => void) => reject(error),
    });
    const getter = () =>
      Object.defineProperty({}, 'then', {
        get() {
          throw error;
        },
      });
    const ordinary = () => ({ then: 1 });
    // JS subscribers can return values outside the TS declaration.
    const handlers = [thenable, getter, ordinary] as unknown as RealtimeFrameHandler[];
    expect(dispatchRealtimeFrame(handlers, FRAME, { failed, succeeded })).toBe(false);
    await setImmediate();
    expect(failed).toHaveBeenCalledWith(getter, error, FRAME);
    expect(failed).toHaveBeenCalledWith(thenable, error, FRAME);
    expect(succeeded).toHaveBeenCalledExactlyOnceWith(ordinary);
  });
});

describe('realtime subscriber error reporter', () => {
  it('warns once per handler, debugs repeats, reports recovery and rearms', () => {
    const logger = {
      warn: vi.fn<(message: string, metadata?: Record<string, unknown>) => void>(),
      debug: vi.fn<(message: string, metadata?: Record<string, unknown>) => void>(),
      info: vi.fn<(message: string, metadata?: Record<string, unknown>) => void>(),
    };
    let sink: typeof logger | undefined = undefined;
    const reporter = createRealtimeHandlerErrorReporter({ source: 'test', logger: () => sink });
    const handler = (): void => {};
    const other = (): void => {};
    reporter.succeeded(handler);
    sink = logger;
    const error = new Error('bad\r\nforged');
    reporter.failed(handler, error, FRAME);
    reporter.failed(handler, new Error('different'), FRAME);
    reporter.failed(handler, error, FRAME);
    reporter.failed(other, error, FRAME);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith('test: subscriber failed: Error: bad forged', {
      source: 'test',
      error: 'Error: bad forged',
      frameKind: 'ws-room',
      frameName: 'room',
    });
    expect(logger.debug.mock.calls.map((call) => call[1]?.repeats)).toEqual([1, 2]);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
    reporter.succeeded(handler);
    reporter.succeeded(handler);
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      'test: subscriber recovered after 3 failures',
      {
        source: 'test',
        failures: 3,
      },
    );
    reporter.failed(handler, error, FRAME);
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('replaces logging with a hook on every failure and swallows hook failures', () => {
    const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
    const hook = vi.fn<(error: unknown, frame: RealtimeFrame) => void>(() => {
      throw new Error('hook');
    });
    const reporter = createRealtimeHandlerErrorReporter({
      source: 'test',
      logger: () => logger,
      onHandlerError: hook,
    });
    const handler = (): void => {};
    for (const error of ['one', 'two']) {
      expect(() => reporter.failed(handler, error, FRAME)).not.toThrow();
    }
    reporter.succeeded(handler);
    expect(hook.mock.calls).toEqual([
      ['one', FRAME],
      ['two', FRAME],
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('swallows failing logger accessors and sinks, including absent loggers', () => {
    const handler = (): void => {};
    const fail = (): never => {
      throw new Error('sink');
    };
    for (const logger of [() => undefined, fail, () => ({ warn: fail, debug: fail, info: fail })]) {
      const reporter = createRealtimeHandlerErrorReporter({ source: 'test', logger });
      expect(() => {
        reporter.failed(handler, 'one', FRAME);
        reporter.failed(handler, 'two', FRAME);
        reporter.succeeded(handler);
      }).not.toThrow();
    }
  });
});
