/**
 * The SSE half of the X3-8 regression guard: a real kernel application
 * reporting subscriber counts for caller-supplied channel names.
 *
 * The exposure is worse here than on the WebSocket side, and this file is
 * where that is pinned. `ChannelRegistry` has no reclamation path at all — no
 * `delete` outside `clear()` — so a channel `channel(name)` creates lives until
 * the process stops. `room()` at least has a sweep on the next disconnection;
 * a leaked channel has nothing.
 *
 * Driven through `app.fetch`, since these routes return ordinary JSON — the
 * streaming-body constraint that forces the other SSE integration file onto a
 * real socket does not apply to a presence read. Registry size is read through
 * `ISseService.channelCount`, whose own control is the leaky case below: the
 * same reading answers 50 when the endpoint is written with `channel()`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES, type ISseService } from '@setu-ts/common';
import { SsePlugin } from '../../src/index.ts';

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

    sse.channel('build:412');

    expect(sse.peek('build:412')).toBeDefined();
    expect(sse.peek('build:413')).toBeUndefined();
    await app.stop();
  });

  it('the same endpoint written with channel() DOES grow the registry, permanently', async () => {
    // The defect reproduced through the same entry point, so the guard above is
    // known to discriminate. Note the second assertion: unlike a room, a leaked
    // channel is never reclaimed while the process runs.
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

    expect(sse.channelCount).toBe(50);
    // Nothing reclaims them: no disconnection sweep exists on this side, so a
    // second reading is identical rather than lower.
    expect(sse.channelCount).toBe(50);
    await app.stop();
  });
});
