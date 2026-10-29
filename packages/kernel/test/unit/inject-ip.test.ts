import { describe, it, expect } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '../../src/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('inject socket peer', () => {
  it('carries a supplied peer and omits it otherwise', async () => {
    const app = createApplication({
      plugins: [
        {
          name: 'runtime',
          version: '0.0.0',
          provides: [CAPABILITIES.RUNTIME],
          register(ctx) {
            ctx.services.register(CAPABILITIES.RUNTIME, createFakeRuntime().runtime);
          },
        },
      ],
    });
    app.router.get('/', (ctx) =>
      ctx.response.json({ ip: ctx.request.ip ?? null, own: Object.hasOwn(ctx.request, 'ip') }),
    );
    await app.start();
    try {
      expect((await app.inject({ method: 'GET', url: '/', ip: '192.0.2.5' })).json()).toEqual({
        ip: '192.0.2.5',
        own: true,
      });
      expect((await app.inject({ method: 'GET', url: '/' })).json()).toEqual({
        ip: null,
        own: false,
      });
    } finally {
      await app.stop();
    }
  });
  it('guards the identity fields through the request prototype, as a served request does', async () => {
    const app = createApplication({
      plugins: [
        {
          name: 'runtime',
          version: '0.0.0',
          provides: [CAPABILITIES.RUNTIME],
          register(ctx) {
            ctx.services.register(CAPABILITIES.RUNTIME, createFakeRuntime().runtime);
          },
        },
      ],
    });
    app.router.get('/', (ctx) => {
      ctx.request.user = { id: 'first', roles: [] };
      let refused = false;
      try {
        ctx.request.user = { id: 'second', roles: [] };
      } catch {
        refused = true;
      }
      return ctx.response.json({
        user: ctx.request.user.id,
        refused,
        own: ['user', 'tenant', 'locale'].filter((field) => Object.hasOwn(ctx.request, field)),
      });
    });
    await app.start();
    try {
      expect((await app.inject({ method: 'GET', url: '/' })).json()).toEqual({
        user: 'first',
        refused: true,
        own: [],
      });
    } finally {
      await app.stop();
    }
  });
});
