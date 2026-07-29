import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { abortReasonOf, linkAbort, throwIfAborted } from '../../src/patterns/abort.ts';
import { TimeoutError } from '../../src/errors.ts';

describe('abortReasonOf', () => {
  it('returns an Error reason untouched, preserving its identity', () => {
    const reason = new TimeoutError();
    const controller = new AbortController();
    controller.abort(reason);
    expect(abortReasonOf(controller.signal)).toBe(reason);
  });

  it('produces an Error when the signal was aborted with no reason', () => {
    const controller = new AbortController();
    // `abort()` with no argument populates `reason` with a runtime-specific
    // DOMException on some runtimes and leaves it undefined on others; both
    // must normalize to a throwable Error.
    controller.abort();
    const reason = abortReasonOf(controller.signal);
    expect(reason instanceof Error).toBe(true);
  });

  it('produces a default Error when a runtime leaves reason undefined', () => {
    // Deno populates `reason` with a DOMException, but the contract does not
    // guarantee it — this simulates a runtime that leaves it unset, which is the
    // branch that otherwise never executes here.
    const controller = new AbortController();
    controller.abort();
    Object.defineProperty(controller.signal, 'reason', { value: undefined });
    const reason = abortReasonOf(controller.signal);
    expect(reason instanceof Error).toBe(true);
    expect(reason.message).toBe('The operation was aborted');
  });

  it('wraps a non-Error reason in an Error rather than returning a bare value', () => {
    const controller = new AbortController();
    controller.abort('shutting down');
    const reason = abortReasonOf(controller.signal);
    expect(reason instanceof Error).toBe(true);
    expect(reason.message).toBe('shutting down');
  });
});

describe('throwIfAborted', () => {
  it('does nothing for an undefined signal', () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });

  it('does nothing for a live signal', () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
  });

  it('throws the signal reason when already aborted', () => {
    const reason = new Error('cancelled');
    const controller = new AbortController();
    controller.abort(reason);
    let caught: unknown;
    try {
      throwIfAborted(controller.signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
  });
});

describe('linkAbort', () => {
  it('returns a no-op disposer and links nothing when there is no outer signal', () => {
    const controller = new AbortController();
    const dispose = linkAbort(undefined, controller);
    dispose();
    expect(controller.signal.aborted).toBe(false);
  });

  it('propagates a later outer abort into the controller with the same reason', () => {
    const outer = new AbortController();
    const inner = new AbortController();
    linkAbort(outer.signal, inner);
    expect(inner.signal.aborted).toBe(false);

    const reason = new Error('caller cancelled');
    outer.abort(reason);
    expect(inner.signal.aborted).toBe(true);
    expect(inner.signal.reason).toBe(reason);
  });

  it('aborts synchronously when the outer signal is already aborted', () => {
    const outer = new AbortController();
    const reason = new Error('already gone');
    outer.abort(reason);

    const inner = new AbortController();
    linkAbort(outer.signal, inner);
    // No window exists in which the inner call would run unaborted.
    expect(inner.signal.aborted).toBe(true);
    expect(inner.signal.reason).toBe(reason);
  });

  it('removes its listener so a long-lived outer signal does not accumulate them', () => {
    const outer = new AbortController();

    // Simulate many wrapped invocations sharing one caller signal. Without the
    // disposer each would leave a listener behind — the leak this asserts is
    // gone.
    const controllers: AbortController[] = [];
    for (let i = 0; i < 50; i++) {
      const inner = new AbortController();
      controllers.push(inner);
      const dispose = linkAbort(outer.signal, inner);
      dispose();
    }

    outer.abort(new Error('late'));
    // Every disposed link is inert: no controller followed the outer abort.
    expect(controllers.every((c) => !c.signal.aborted)).toBe(true);
  });
});
