/**
 * The SSE half of the X3-8 regression guard: a real kernel application
 * reporting subscriber counts for caller-supplied channel names.
 *
 * Driven through `app.fetch`, since these routes return ordinary JSON — the
 * streaming-body constraint that forces the other SSE integration file onto a
 * real socket does not apply to a presence read. Registry size is read through
 * `ISseService.channelCount`; empty channel handles are not retained.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES, type ISseService } from '@setu-ts/common';
import { SsePlugin } from '../../src/index.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('SSE presence over peek (M74 / X3-8)', () => {
  it('reports subscriber counts for caller-supplied names without registering them', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), SsePlugin()] });
    await app.start();
    const sse = app.services.get<ISseService>(CAPABILITIES.SSE);

    app.router.get('/subscribers/:build', (ctx) => {
      const build = ctx.params.build ?? '';
      return ctx.response.json({ subscribers: sse.peek(`build:${build}`)?.size ?? 0 });
    });

    const before = sse.channelCount;

    for (let i = 0; i < 50; i++) {
      const response = await app.fetch(new Request(`http://localhost/subscribers/${i}`));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ subscribers: 0 });
    }

    expect(sse.channelCount).toBe(before);
    await app.stop();
  });

  it('reports the real size for a channel that exists', async () => {
    // Guards the test above against a peek that always answered undefined.
    const app = createApplication({ plugins: [RuntimePlugin(), SsePlugin()] });
    await app.start();
    const sse = app.services.get<ISseService>(CAPABILITIES.SSE);

    sse.channel('build:412').add(sse.open(createFakeContext({ runtime: createFakeRuntime() })));

    expect(sse.peek('build:412')).toBeDefined();
    expect(sse.peek('build:413')).toBeUndefined();
    await app.stop();
  });

  it('reading empty handles through channel() does not retain registry entries', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), SsePlugin()] });
    await app.start();
    const sse = app.services.get<ISseService>(CAPABILITIES.SSE);

    app.router.get('/leaky/:build', (ctx) => {
      const build = ctx.params.build ?? '';
      return ctx.response.json({ subscribers: sse.channel(`build:${build}`).size });
    });

    for (let i = 0; i < 50; i++) {
      await app.fetch(new Request(`http://localhost/leaky/${i}`));
    }

    expect(sse.channelCount).toBe(0);
    await app.stop();
  });
});
