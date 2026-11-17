import { describe, expect, it, vi } from 'vitest';
import type { MiddlewareFunction, RouteDefinition } from '@setu-ts/common';
import { createApplication } from '../../src/index.ts';
import { runtimePlugin } from '../fixtures/runtime-plugin.ts';
import { DiagnosticsCollector } from '../../src/diagnostics/collector.ts';

describe('route middleware groups', () => {
  async function exercise(definition: RouteDefinition, diagnostics = false) {
    const errors: unknown[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'error-observer',
          version: '1.0.0',
          register(ctx) {
            ctx.lifecycle.onError((error) => {
              errors.push(error);
            });
          },
        },
      ],
      ...(diagnostics ? { diagnostics: {} } : {}),
    });
    app.router.post('/page', definition);
    await app.start();
    try {
      const response = await app.inject({ method: 'POST', url: '/page' });
      return {
        errors,
        response,
        snapshot: app.diagnostics?.snapshot(),
        events: app.diagnostics?.read(0).events,
      };
    } finally {
      await app.stop();
    }
  }

  it('runs static, selection, groups in selection order, then handler and unwinds', async () => {
    const observed = vi.spyOn(DiagnosticsCollector.prototype, 'observeMiddlewareStage');
    const calls: string[] = [];
    const stage =
      (name: string): MiddlewareFunction =>
      async (_ctx, next) => {
        calls.push(name);
        await next();
        calls.push(`${name}:after`);
      };
    const { response, events, snapshot } = await exercise(
      {
        middleware: [stage('static')],
        middlewareGroups: {
          groups: { a: [stage('a')], b: [stage('b'), stage('c')] },
          select: () => {
            calls.push('select');
            return ['b', 'a'];
          },
        },
        handler: (ctx) => {
          calls.push('handler');
          return ctx.response.status(201).text('rendered');
        },
      },
      true,
    );
    expect(response.statusCode).toBe(201);
    expect(calls).toEqual([
      'static',
      'select',
      'b',
      'c',
      'a',
      'handler',
      'a:after',
      'c:after',
      'b:after',
      'static:after',
    ]);
    const stages = events!.filter(
      (event) => event.kind === 'middleware' && event.stage === 'route',
    );
    expect(stages).toHaveLength(4);
    expect(
      observed.mock.calls
        .filter(([stage]) => stage.scope === 'route')
        .map(([stage]) => stage.position),
    ).toEqual([3, 2, 1, 0]);
    observed.mockRestore();
    expect(JSON.stringify(snapshot)).toContain('route');
  });

  it.each([{ selection: [] }, { selection: ['empty'] }])(
    'bypasses an empty selection $selection',
    async ({ selection }) => {
      const { response } = await exercise({
        middlewareGroups: { groups: { empty: [] }, select: () => selection },
        handler: (ctx) => ctx.response.text('handler'),
      });
      expect(response.body).toBe('handler');
    },
  );

  it('a responding group stops later groups and the handler', async () => {
    const calls: string[] = [];
    const { response } = await exercise({
      middlewareGroups: {
        groups: {
          refuse: [
            (ctx) => {
              calls.push('refuse');
              return ctx.response.status(429).text('blocked');
            },
          ],
          later: [
            (_ctx, next) => {
              calls.push('later');
              return next();
            },
          ],
        },
        select: () => ['refuse', 'later'],
      },
      handler: (ctx) => {
        calls.push('handler');
        return ctx.response.text('overwritten');
      },
    });
    expect(response.statusCode).toBe(429);
    expect(response.body).toBe('blocked');
    expect(calls).toEqual(['refuse']);
  });

  it.each(['missing', 'constructor', 'toString', '__proto__'])(
    'refuses undeclared %s before any group executes',
    async (key) => {
      const calls: string[] = [];
      const { response, errors } = await exercise({
        middlewareGroups: {
          groups: {
            good: [
              (_ctx, next) => {
                calls.push('group');
                return next();
              },
            ],
          },
          select: () => ['good', key],
        },
        handler: (ctx) => {
          calls.push('handler');
          return ctx.response.text('unsafe');
        },
      });
      expect(response.statusCode).toBe(500);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toBe(`route middleware group '${key}' is not declared`);
      expect(calls).toEqual([]);
    },
  );

  it.each(['throw', 'reject'])(
    'select %s uses the error path without invoking the handler',
    async (mode) => {
      let rendered = false;
      const { response } = await exercise({
        middlewareGroups: {
          groups: {},
          select: () => {
            if (mode === 'throw') throw new Error('selection failed');
            return Promise.reject(new Error('selection failed'));
          },
        },
        handler: (ctx) => {
          rendered = true;
          return ctx.response.text('unsafe');
        },
      });
      expect(response.statusCode).toBe(500);
      expect(rendered).toBe(false);
    },
  );

  it.each([false, true])(
    'static refusal prevents selection, even with next()=%s',
    async (callNext) => {
      let selected = false;
      let rendered = false;
      const { response } = await exercise({
        middleware: [
          (ctx, next) => {
            ctx.response.status(403).text('static');
            return callNext ? next() : undefined;
          },
        ],
        middlewareGroups: {
          groups: {},
          select: () => {
            selected = true;
            return [];
          },
        },
        handler: (ctx) => {
          rendered = true;
          return ctx.response.text('unsafe');
        },
      });
      expect(response.statusCode).toBe(403);
      expect(selected).toBe(false);
      expect(rendered).toBe(false);
    },
  );

  it('a selector ending the response keeps the empty-chain ended defense', async () => {
    let rendered = false;
    const { response } = await exercise({
      middlewareGroups: {
        groups: {},
        select: (ctx) => {
          ctx.response.status(403).text('selected');
          return [];
        },
      },
      handler: (ctx) => {
        rendered = true;
        return ctx.response.text('unsafe');
      },
    });
    expect(response.statusCode).toBe(403);
    expect(rendered).toBe(false);
  });
});
