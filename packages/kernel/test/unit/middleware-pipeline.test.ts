import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRequestContext } from '@hono-enterprise/common';
import { MiddlewarePipeline } from '../../src/pipeline/middleware-pipeline.ts';

function emptyCtx(): IRequestContext {
  return {} as IRequestContext;
}

describe('MiddlewarePipeline', () => {
  it('should execute middleware in priority order', async () => {
    const pipeline = new MiddlewarePipeline();
    const order: number[] = [];

    pipeline.add((_ctx, next) => {
      order.push(300);
      next();
    }, { priority: 300 });
    pipeline.add((_ctx, next) => {
      order.push(100);
      next();
    }, { priority: 100 });
    pipeline.add((_ctx, next) => {
      order.push(200);
      next();
    }, { priority: 200 });

    await pipeline.execute(emptyCtx(), async () => {});
    expect(order).toEqual([100, 200, 300]);
  });

  it('should default priority to 500', async () => {
    const pipeline = new MiddlewarePipeline();
    const order: number[] = [];

    pipeline.add((_ctx, next) => {
      order.push(500);
      next();
    });
    pipeline.add((_ctx, next) => {
      order.push(100);
      next();
    }, { priority: 100 });

    await pipeline.execute(emptyCtx(), async () => {});
    expect(order).toEqual([100, 500]);
  });

  it('should call terminal when no middleware', async () => {
    const pipeline = new MiddlewarePipeline();
    let called = false;
    await pipeline.execute(emptyCtx(), () => {
      called = true;
      return Promise.resolve();
    });
    expect(called).toBe(true);
  });

  it('should allow short-circuit (not calling next)', async () => {
    const pipeline = new MiddlewarePipeline();
    const called: boolean[] = [false];

    pipeline.add((_ctx, _next) => {
      // Short-circuit — do not call next
    });
    pipeline.add((_ctx, _next) => {
      called[0] = true;
    });

    await pipeline.execute(emptyCtx(), async () => {});
    expect(called[0]).toBe(false);
  });

  it('should throw on double next()', async () => {
    const pipeline = new MiddlewarePipeline();
    let nextFn: (() => Promise<void>) | null = null;

    pipeline.add((_ctx, next) => {
      nextFn = next;
      next();
    });

    await pipeline.execute(emptyCtx(), async () => {});
    // After execute, next() was already called once — calling again throws
    expect(() => nextFn!()).toThrow('next() called multiple times');
  });

  it('should throw on double next() during execution', async () => {
    const pipeline = new MiddlewarePipeline();
    const order: string[] = [];

    pipeline.add((_ctx, next) => {
      order.push('first');
      next();
      // Calling next again should throw
      expect(() => next()).toThrow('next() called multiple times');
    });
    pipeline.add((_ctx, next) => {
      order.push('second');
      next();
    });

    await pipeline.execute(emptyCtx(), async () => {});
    expect(order).toEqual(['first', 'second']);
  });

  it('should propagate errors', async () => {
    const pipeline = new MiddlewarePipeline();
    const error = new Error('test error');

    pipeline.add((_ctx, _next) => {
      throw error;
    });

    await expect(pipeline.execute(emptyCtx(), async () => {})).rejects.toThrow('test error');
  });

  it('should throw when adding middleware after compile', () => {
    const pipeline = new MiddlewarePipeline();
    pipeline.add(() => {});
    pipeline.compile();
    expect(() => pipeline.add(() => {})).toThrow('after the pipeline has been compiled');
  });
});
