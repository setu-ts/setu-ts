import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
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
