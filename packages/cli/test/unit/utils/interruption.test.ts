import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  awaitInterruptibly,
  InterruptedError,
  interruptionMessage,
  throwIfInterrupted,
} from '../../../src/utils/interruption.ts';

describe('throwIfInterrupted', () => {
  it('does nothing without an aborted signal', () => {
    expect(() => throwIfInterrupted()).not.toThrow();
    expect(() => throwIfInterrupted(new AbortController().signal)).not.toThrow();
  });

  it('throws InterruptedError after abort', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfInterrupted(controller.signal)).toThrow(InterruptedError);
  });
});

describe('awaitInterruptibly', () => {
  it('returns ordinary results with and without a signal and propagates failures', async () => {
    expect(await awaitInterruptibly(() => 7)).toBe(7);
    expect(await awaitInterruptibly(() => 8, new AbortController().signal)).toBe(8);
    await expect(awaitInterruptibly(() => {
      throw new Error('handler failed');
    }, new AbortController().signal)).rejects.toThrow('handler failed');
  });

  it('does not start an already-interrupted operation', async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    await expect(awaitInterruptibly(() => {
      ran = true;
    }, controller.signal))
      .rejects.toBeInstanceOf(InterruptedError);
    expect(ran).toBe(false);
  });

  it('observes a late handler rejection after an abort and removes its listener', async () => {
    const controller = new AbortController();
    let reject: (cause: Error) => void = () => {};
    const pending = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const result = awaitInterruptibly(() => {
      controller.abort();
      return pending;
    }, controller.signal);
    await expect(result).rejects.toBeInstanceOf(InterruptedError);
    reject(new Error('late failure'));
    await Promise.resolve();
  });
});

describe('interruptionMessage', () => {
  it('describes complete and incomplete interruption rollback', () => {
    const interrupted = new InterruptedError();
    expect(interruptionMessage(interrupted)).toContain('files this run wrote were removed');
    expect(interruptionMessage(
      new AggregateError(
        [interrupted, new Error('/work/app: not empty')],
        'rollback incomplete: /work/app: not empty',
        { cause: interrupted },
      ),
    )).toContain('/work/app: not empty');
    expect(interruptionMessage(new Error('ordinary failure'))).toBeUndefined();
  });
});
