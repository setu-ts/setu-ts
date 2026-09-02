/**
 * Behaviour tests for the shared `composeBehaviorChain` composer (M86 §3.4).
 *
 * One composer serves the CQRS pipeline and the four non-HTTP ingress chains,
 * so every call below type-checks against BOTH parameterizations:
 * `BehaviorLike<IngressContext, void>` (ingress) and
 * `BehaviorLike<CqrsRequest, unknown>` (CQRS, via an `IPipelineBehavior`) —
 * the proof that one composer serves both.
 *
 * Every assertion states call ORDER and COUNT, not merely that the chain ran.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { CqrsRequest, IPipelineBehavior } from '../../src/services/cqrs.ts';
import {
  type BehaviorLike,
  composeBehaviorChain,
  type IngressContext,
} from '../../src/services/ingress.ts';

const queueEnvelope: IngressContext = {
  kind: 'queue',
  name: 'email.send',
  payload: { to: 'ada@example.com' },
  attempt: 1,
};

describe('composeBehaviorChain (M86 §3.4)', () => {
  it('runs behaviours in declared order and the terminal last', async () => {
    const calls: string[] = [];
    const seen: IngressContext[] = [];
    const behaviors: BehaviorLike<IngressContext, void>[] = [
      {
        handle: (ctx, next) => {
          seen.push(ctx);
          calls.push('first');
          return next();
        },
      },
      {
        handle: (ctx, next) => {
          seen.push(ctx);
          calls.push('second');
          return next();
        },
      },
    ];

    await composeBehaviorChain<IngressContext, void>(queueEnvelope, behaviors, () => {
      calls.push('terminal');
      return Promise.resolve();
    });

    expect(calls).toEqual(['first', 'second', 'terminal']);
    // The envelope reaches every behaviour by reference.
    expect(seen[0]).toBe(queueEnvelope);
    expect(seen[1]).toBe(queueEnvelope);
  });

  it('short-circuits when a behaviour returns without calling next()', async () => {
    const calls: string[] = [];
    let terminalCalls = 0;
    const behaviors: BehaviorLike<IngressContext, void>[] = [
      {
        handle: (_ctx, next) => {
          calls.push('first');
          return next();
        },
      },
      {
        handle: () => {
          calls.push('second');
        },
      },
      {
        handle: (_ctx, next) => {
          calls.push('third');
          return next();
        },
      },
    ];

    await composeBehaviorChain<IngressContext, void>(queueEnvelope, behaviors, () => {
      terminalCalls += 1;
      return Promise.resolve();
    });

    // Downstream behaviours AND the terminal are skipped.
    expect(calls).toEqual(['first', 'second']);
    expect(terminalCalls).toBe(0);
  });

  it('invokes the terminal exactly once with an empty array', async () => {
    let terminalCalls = 0;

    const result = await composeBehaviorChain<IngressContext, string>(queueEnvelope, [], () => {
      terminalCalls += 1;
      return Promise.resolve('handled');
    });

    expect(terminalCalls).toBe(1);
    expect(result).toBe('handled');
  });

  it('propagates a behaviour rejection to the caller', async () => {
    const failure = new Error('tenant guard failed');
    const behaviors: BehaviorLike<IngressContext, void>[] = [
      { handle: () => Promise.reject(failure) },
    ];
    let terminalCalls = 0;
    let caught: unknown;

    try {
      await composeBehaviorChain<IngressContext, void>(queueEnvelope, behaviors, () => {
        terminalCalls += 1;
        return Promise.resolve();
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(terminalCalls).toBe(0);
  });

  it('propagates a SYNCHRONOUS behaviour throw as a rejection, never a sync throw', async () => {
    const failure = new Error('guard blew up synchronously');
    const behaviors: BehaviorLike<IngressContext, void>[] = [
      {
        handle: () => {
          throw failure;
        },
      },
    ];
    let terminalCalls = 0;
    let caught: unknown;

    // The declared return type is a promise, so a caller writing `.catch(...)`
    // must see this failure — a synchronous escape would bypass it (the M52b
    // defect class).
    try {
      await composeBehaviorChain<IngressContext, void>(queueEnvelope, behaviors, () => {
        terminalCalls += 1;
        return Promise.resolve();
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(terminalCalls).toBe(0);
  });

  it('type-checks against BehaviorLike<IngressContext, void> (the ingress shape)', async () => {
    const seen: IngressContext[] = [];
    const behaviors: BehaviorLike<IngressContext, void>[] = [
      {
        handle: (ctx, next) => {
          seen.push(ctx);
          return next();
        },
      },
    ];
    const frameEnvelope: IngressContext = {
      kind: 'websocket',
      name: '/ws/room',
      payload: 'frame-data',
    };
    let terminalCalls = 0;

    await composeBehaviorChain<IngressContext, void>(frameEnvelope, behaviors, () => {
      terminalCalls += 1;
      return Promise.resolve();
    });

    expect(seen).toEqual([frameEnvelope]);
    expect(terminalCalls).toBe(1);
  });

  it('feeds an IPipelineBehavior — one composer serves the CQRS pipeline', async () => {
    const calls: string[] = [];
    const behavior: IPipelineBehavior<CqrsRequest, number> = {
      handle: (request, next) => {
        calls.push(`behavior:${request.type}`);
        return next();
      },
    };

    const result = await composeBehaviorChain<CqrsRequest, number>(
      { type: 'GetCount', data: {} },
      [behavior],
      () => {
        calls.push('terminal');
        return Promise.resolve(10);
      },
    );

    expect(calls).toEqual(['behavior:GetCount', 'terminal']);
    expect(result).toBe(10);
  });

  it('applies behaviours[0] last to a result: declared order = wrap order', async () => {
    const result = await composeBehaviorChain<CqrsRequest, number>(
      { type: 'GetCount', data: {} },
      [
        { handle: (_request, next) => next().then((count) => count + 1) },
        { handle: (_request, next) => next().then((count) => count * 2) },
      ],
      () => Promise.resolve(10),
    );

    // `behaviors[0]` is outermost, so it transforms LAST: 10 → *2 → +1 = 21.
    // The reverse order would answer 12.
    expect(result).toBe(21);
  });

  it('a CQRS short-circuit value becomes the chain result without the terminal', async () => {
    const result = await composeBehaviorChain<CqrsRequest, string>(
      { type: 'GetCached', data: {} },
      [{ handle: () => 'from-cache' }],
      () => {
        throw new Error('terminal must not run after a short-circuit');
      },
    );

    expect(result).toBe('from-cache');
  });
});
