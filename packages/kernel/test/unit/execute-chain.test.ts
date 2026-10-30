import { describe, expect, it } from 'vitest';
import type { IRequestContext, MiddlewareFunction, NextFunction } from '@setu-ts/common';

import { executeChain } from '../../src/pipeline/execute-chain.ts';
import type { ChainObserver } from '../../src/pipeline/execute-chain.ts';
import { ResponseBuilder } from '../../src/context/response.ts';

/** Builds a real context backed by a ResponseBuilder. */
function ctxWithResponse(): IRequestContext {
  return { response: new ResponseBuilder() } as unknown as IRequestContext;
}

/** Builds a minimal context with no `response` (exercises the guard). */
function bareCtx(): IRequestContext {
  return {} as IRequestContext;
}

/** Terminal that records it ran (no await needed). */
function recordingTerminal(order: string[], label: string): () => Promise<void> {
  return () => {
    order.push(label);
    return Promise.resolve();
  };
}

/**
 * Both dispatch paths must honour the same chaining semantics: the plain path
 * every request takes without diagnostics, and the observed path.
 */
const MODES: readonly (readonly [string, ChainObserver | undefined])[] = [
  ['without an observer', undefined],
  ['with an observer', { clock: () => 0, onStage: () => {} }],
];

describe.each(MODES)('executeChain %s', (_mode, observer) => {
  const run = (
    chain: readonly MiddlewareFunction[],
    ctx: IRequestContext,
    terminal: () => Promise<void>,
    names?: readonly string[],
  ): Promise<void> => executeChain(chain, ctx, terminal, names, observer);

  it('runs middleware in order and the terminal last', async () => {
    const order: string[] = [];
    const chain: MiddlewareFunction[] = [
      (_c, next) => {
        order.push('a');
        return next();
      },
      (_c, next) => {
        order.push('b');
        return next();
      },
    ];
    await run(chain, bareCtx(), recordingTerminal(order, 'terminal'));
    expect(order).toEqual(['a', 'b', 'terminal']);
  });

  it('short-circuits when a stage does not call next()', async () => {
    const order: string[] = [];
    const chain: MiddlewareFunction[] = [
      () => {
        order.push('a');
      },
      () => {
        order.push('b');
      },
    ];
    await run(chain, bareCtx(), recordingTerminal(order, 'terminal'));
    expect(order).toEqual(['a']);
  });

  it('throws on double next()', async () => {
    let nextFn: (() => Promise<void>) | null = null;
    const chain: MiddlewareFunction[] = [
      (_c, next) => {
        nextFn = next;
        return next();
      },
    ];
    await run(chain, bareCtx(), () => Promise.resolve());
    expect(() => nextFn!()).toThrow('next() called multiple times');
  });

  it('defense-in-depth: a stage that responds AND calls next() stops downstream stages', async () => {
    const order: string[] = [];
    const ctx = ctxWithResponse();
    const chain: MiddlewareFunction[] = [
      (c, next) => {
        order.push('a');
        c.response.status(418).json({ err: 'teapot' });
        return next(); // incorrectly calls next after responding
      },
      (c) => {
        order.push('b');
        return c.response.json({ ok: true });
      },
    ];
    await run(chain, ctx, recordingTerminal(order, 'terminal'));
    expect(order).toEqual(['a']);
    expect((ctx.response as ResponseBuilder).snapshot().status).toBe(418);
  });

  it('defense-in-depth: terminal is skipped when a prior stage ended the response', async () => {
    const order: string[] = [];
    const ctx = ctxWithResponse();
    // A single stage that responds and calls next — the terminal must not run.
    const chain: MiddlewareFunction[] = [
      (c, next) => {
        order.push('a');
        c.response.json({ done: true });
        return next();
      },
    ];
    await run(chain, ctx, recordingTerminal(order, 'terminal'));
    expect(order).toEqual(['a']);
  });

  it('runs the terminal when no middleware ends the response', async () => {
    let terminalRan = false;
    const ctx = ctxWithResponse();
    await run([], ctx, () => {
      terminalRan = true;
      return Promise.resolve();
    });
    expect(terminalRan).toBe(true);
  });

  it('propagates errors thrown by a stage', async () => {
    const chain: MiddlewareFunction[] = [
      () => {
        throw new Error('boom');
      },
    ];
    await expect(run(chain, bareCtx(), () => Promise.resolve())).rejects.toThrow('boom');
  });

  // Route-level chains pass no `names` array, so the label falls back to the
  // function's own name — and to '<anonymous>' when that is the empty string.
  it('labels a double next() with the function name when no names are supplied', async () => {
    async function authGuard(_ctx: IRequestContext, next: NextFunction): Promise<void> {
      await next();
      expect(() => next()).toThrow('next() called multiple times in middleware authGuard');
    }

    await run([authGuard], ctxWithResponse(), () => Promise.resolve());
  });

  it('labels a double next() <anonymous> for a function with an empty name', async () => {
    const anonymous = ((_ctx: IRequestContext, next: NextFunction) => {
      next();
      expect(() => next()).toThrow('next() called multiple times in middleware <anonymous>');
    }) as MiddlewareFunction;
    // An inline arrow assigned to a `const` inherits that name, so strip it to
    // reach the '' case a route middleware built by `.bind()` or a factory hits.
    Object.defineProperty(anonymous, 'name', { value: '' });

    await run([anonymous], ctxWithResponse(), () => Promise.resolve());
  });

  it('prefers a supplied diagnostic name over the function name', async () => {
    async function inner(_ctx: IRequestContext, next: NextFunction): Promise<void> {
      await next();
      expect(() => next()).toThrow('next() called multiple times in middleware registered-label');
    }

    await run([inner], ctxWithResponse(), () => Promise.resolve(), ['registered-label']);
  });
  it('turns a synchronous throw from the terminal into a rejection', async () => {
    const terminal = (): Promise<void> => {
      throw new Error('terminal boom');
    };
    let settled: Promise<void> | undefined;
    expect(() => {
      settled = run([], ctxWithResponse(), terminal);
    }).not.toThrow();
    await expect(settled).rejects.toThrow('terminal boom');
  });

  it('turns a synchronous throw from a stage into a rejection', () => {
    const chain: MiddlewareFunction[] = [
      () => {
        throw new Error('stage boom');
      },
    ];
    const settled = run(chain, ctxWithResponse(), () => Promise.resolve());
    return expect(settled).rejects.toThrow('stage boom');
  });

  it('runs synchronous stages that return no promise', async () => {
    const order: string[] = [];
    const chain = [
      ((_ctx: IRequestContext, next: NextFunction) => {
        order.push('a');
        void next();
      }) as MiddlewareFunction,
      ((_ctx: IRequestContext, next: NextFunction) => {
        order.push('b');
        void next();
      }) as MiddlewareFunction,
    ];
    await run(chain, ctxWithResponse(), recordingTerminal(order, 'terminal'));
    expect(order).toEqual(['a', 'b', 'terminal']);
  });

  it('rejects when a synchronous stage calls next() twice', async () => {
    const chain = [
      function twice(_ctx: IRequestContext, next: NextFunction): void {
        void next();
        void next();
      } as MiddlewareFunction,
    ];
    await expect(run(chain, ctxWithResponse(), () => Promise.resolve())).rejects.toThrow(
      'next() called multiple times in middleware twice',
    );
  });
});
