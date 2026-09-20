import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '../../src/application/application.ts';
import { runtimePlugin } from '../fixtures/runtime-plugin.ts';

const CANARY = 'CANARY-secret-9f2b';

describe('diagnostics capture canaries', () => {
  it('hostile request data and error text never reach snapshots or batches', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'hostile',
          version: '1.0.0',
          register(ctx) {
            ctx.middleware.add((ctx, next) => {
              // Secrets in the exact places capture minimization excludes.
              ctx.state.set('session', { token: CANARY });
              ctx.request.headers.set('x-injected', CANARY);
              return next();
            }, { name: 'leaky', priority: 10 });
            ctx.router.get('/items', (ctx) => {
              // The URL carried the canary as a query value.
              return ctx.response.json({ items: [] });
            });
            ctx.router.get('/boom', () => {
              throw new Error(`exploded with ${CANARY}`);
            });
          },
        },
      ],
      diagnostics: {},
    });
    await app.start();
    await app.inject({ method: 'GET', url: `/items?q=${encodeURIComponent(CANARY)}` });
    await app.inject({ method: 'GET', url: '/boom' });
    await app.inject({ method: 'GET', url: '/missing' });

    const snapshotJson = JSON.stringify(app.diagnostics!.snapshot());
    const batchJson = JSON.stringify(app.diagnostics!.read(0));
    expect(snapshotJson).not.toContain(CANARY);
    expect(batchJson).not.toContain(CANARY);
    // No header, no URL, no state key, no error message text.
    expect(batchJson).not.toContain('x-injected');
    expect(batchJson).not.toContain('/items');

    // Non-vacuous: useful allowed metadata IS present.
    expect(batchJson).toContain('"handler"');
    expect(batchJson).toContain('"error"');
    expect(snapshotJson).toContain('"kind"');
    expect(snapshotJson).toContain('"capability"');
    await app.stop();
  });

  it('an unallowlisted plugin name and route pattern stay out of the output', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'secretly-named-plugin',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/private-path', (c) => c.response.json({}));
          },
        },
      ],
      // No labels at all: nothing named may leave the process.
      diagnostics: {},
    });
    await app.start();
    await app.inject({ method: 'GET', url: '/private-path' });
    const everything = JSON.stringify(app.diagnostics!.snapshot()) +
      JSON.stringify(app.diagnostics!.read(0));
    expect(everything).not.toContain('secretly-named-plugin');
    expect(everything).not.toContain('/private-path');
    // Non-vacuous: ids and stages still are.
    expect(everything).toContain('"p1"');
    await app.stop();
  });

  it('an allowlisted label is a disclosure decision and does appear', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'approved-name',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/approved', (c) => c.response.json({}));
          },
        },
      ],
      diagnostics: { labels: { plugins: ['approved-name'] } },
    });
    await app.start();
    const snapshotJson = JSON.stringify(app.diagnostics!.snapshot());
    expect(snapshotJson).toContain('approved-name');
    await app.stop();
  });
});
