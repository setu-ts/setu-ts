/**
 * Pipeline behavior composition tests.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { composePipeline } from '../../src/behaviors/pipeline-behavior.ts';
import type { CqrsPipelineBehavior } from '@hono-enterprise/common';

describe('composePipeline', () => {
  it('should call the terminal handler when no behaviors are provided', async () => {
    let called = false;
    const terminal = (): Promise<string> => {
      called = true;
      return Promise.resolve('result');
    };

    const req = { type: 'Test', data: {} };
    const result = await composePipeline(req, [], terminal);

    expect(called).toBe(true);
    expect(result).toBe('result');
  });

  it('should wrap the terminal with a single behavior', async () => {
    const calls: string[] = [];

    const behavior: CqrsPipelineBehavior = {
      handle: (_req, next) => {
        calls.push('before');
        return next().then((r) => {
          calls.push('after');
          return r;
        });
      },
    };

    const terminal = (): Promise<string> => {
      calls.push('terminal');
      return Promise.resolve('result');
    };

    const req = { type: 'Test', data: {} };
    const result = await composePipeline(req, [behavior], terminal);

    expect(calls).toEqual(['before', 'terminal', 'after']);
    expect(result).toBe('result');
  });

  it('should run multiple behaviors in declared order', async () => {
    const calls: string[] = [];

    const behavior1: CqrsPipelineBehavior = {
      handle: (_req, next) => {
        calls.push('b1-before');
        return next().then((r) => {
          calls.push('b1-after');
          return r;
        });
      },
    };

    const behavior2: CqrsPipelineBehavior = {
      handle: (_req, next) => {
        calls.push('b2-before');
        return next().then((r) => {
          calls.push('b2-after');
          return r;
        });
      },
    };

    const terminal = (): Promise<string> => {
      calls.push('terminal');
      return Promise.resolve('result');
    };

    const req = { type: 'Test', data: {} };
    await composePipeline(req, [behavior1, behavior2], terminal);

    expect(calls).toEqual([
      'b1-before',
      'b2-before',
      'terminal',
      'b2-after',
      'b1-after',
    ]);
  });

  it('should short-circuit when a behavior does not call next()', async () => {
    const calls: string[] = [];

    const shortCircuitBehavior: CqrsPipelineBehavior = {
      handle: (_req, _next) => {
        calls.push('short-circuit');
        return 'early';
      },
    };

    const behaviorAfter: CqrsPipelineBehavior = {
      handle: (_req, next) => {
        calls.push('after');
        return next();
      },
    };

    const terminal = (): Promise<string> => {
      calls.push('terminal');
      return Promise.resolve('result');
    };

    const req = { type: 'Test', data: {} };
    const result = await composePipeline(req, [shortCircuitBehavior, behaviorAfter], terminal);

    expect(calls).toEqual(['short-circuit']);
    expect(result).toBe('early');
  });

  it('should normalize sync returns to promises', async () => {
    const behavior: CqrsPipelineBehavior = {
      handle: (_req, next) => {
        return next();
      },
    };

    const terminal = (): Promise<string> => Promise.resolve('sync-result');

    const req = { type: 'Test', data: {} };
    const result = await composePipeline(req, [behavior], terminal);

    expect(result).toBe('sync-result');
  });

  it('should handle async terminal', async () => {
    const terminal = async (): Promise<string> => {
      await Promise.resolve();
      return 'async-result';
    };

    const req = { type: 'Test', data: {} };
    const result = await composePipeline(req, [], terminal);

    expect(result).toBe('async-result');
  });
});
