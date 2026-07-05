import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRequestContext, MiddlewareFunction } from '@hono-enterprise/common';

import { executeChain } from '../../src/pipeline/execute-chain.ts';
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

describe('executeChain', () => {
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
    await executeChain(chain, bareCtx(), recordingTerminal(order, 'terminal'));
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
    await executeChain(chain, bareCtx(), recordingTerminal(order, 'terminal'));
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
    await executeChain(chain, bareCtx(), () => Promise.resolve());
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
    await executeChain(chain, ctx, recordingTerminal(order, 'terminal'));
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
    await executeChain(chain, ctx, recordingTerminal(order, 'terminal'));
    expect(order).toEqual(['a']);
  });

  it('runs the terminal when no middleware ends the response', async () => {
    let terminalRan = false;
    const ctx = ctxWithResponse();
    await executeChain([], ctx, () => {
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
    await expect(executeChain(chain, bareCtx(), () => Promise.resolve())).rejects.toThrow('boom');
  });
});
