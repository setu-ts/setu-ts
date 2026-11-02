/**
 * A streamed body that emits zero-length chunks without pause must not starve
 * the event loop (M133 audit: the Node adapter's writer turned such a source
 * into an unbounded promise chain and the process ran out of memory).
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '../../src/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function appStreaming(source: () => ReadableStream<Uint8Array>) {
  const fake = createFakeRuntime();
  const app = createApplication({
    plugins: [
      {
        name: 'runtime',
        version: '1',
        provides: [CAPABILITIES.RUNTIME],
        register(ctx) {
          ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
        },
      },
    ],
  });
  app.router.get('/stream', (ctx) => ctx.response.stream(source()));
  return { app, tick: fake.tick };
}

describe('empty streamed chunks', () => {
  it('never delivers an empty chunk and yields a timer turn between them', async () => {
    let pulls = 0;
    let cancelled = false;
    const { app } = appStreaming(
      () =>
        new ReadableStream<Uint8Array>({
          pull(controller): void {
            pulls++;
            controller.enqueue(new Uint8Array(0));
          },
          cancel(): void {
            cancelled = true;
          },
        }),
    );
    await app.start();
    try {
      const response = await app.dispatch!(new Request('http://localhost/stream'));
      const reader = response.body!.getReader();
      let delivered = false;
      void reader.read().then(() => (delivered = true));
      await settle();
      // Unguarded, the empty chunk is delivered at once and the source is pulled
      // in a tight microtask loop; guarded, nothing arrives and the source has
      // been read only up to the first timer wait.
      expect(delivered).toBe(false);
      expect(pulls).toBeLessThanOrEqual(2);
      await reader.cancel('client gone');
      expect(cancelled).toBe(true);
    } finally {
      await app.stop();
    }
  });

  it('delivers the bytes that follow a run of empty chunks', async () => {
    const chunks = [new Uint8Array(0), new Uint8Array(0), new TextEncoder().encode('ok')];
    let index = 0;
    const { app, tick } = appStreaming(
      () =>
        new ReadableStream<Uint8Array>({
          pull(controller): void {
            if (index < chunks.length) controller.enqueue(chunks[index++]!);
            else controller.close();
          },
        }),
    );
    await app.start();
    try {
      const response = await app.dispatch!(new Request('http://localhost/stream'));
      const text = response.text();
      for (let i = 0; i < 3; i++) {
        await settle();
        tick(0);
      }
      expect(await text).toBe('ok');
    } finally {
      await app.stop();
    }
  });
});
