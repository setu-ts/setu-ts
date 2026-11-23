/**
 * The drain marker on a real Node socket: a request refused during `stop()`'s
 * drain carries `x-setu-unprocessed: shutdown`, and a request admitted before
 * the drain that answers 503 itself does not.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { UNPROCESSED_HEADER, UNPROCESSED_SHUTDOWN } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { unusedPort } from '../../../../test/node-helpers.ts';
import { RuntimePlugin } from '../../src/index.ts';

describe('Node drain marker on the wire', () => {
  it('marks refused requests while an admitted request finishes unmarked', async () => {
    const port = await unusedPort();
    let entered!: () => void;
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createApplication({ plugins: [RuntimePlugin()] });
    app.router.get('/pending', async (ctx) => {
      entered();
      await gate;
      return ctx.response.status(503).text('processed');
    });
    await app.start({ port, hostname: '127.0.0.1' });
    const pending = fetch(`http://127.0.0.1:${port}/pending`);
    await admitted;
    const stopping = app.stop();
    try {
      const refused = await fetch(`http://127.0.0.1:${port}/new`);
      expect(refused.status).toBe(503);
      expect(refused.headers.get(UNPROCESSED_HEADER)).toBe(UNPROCESSED_SHUTDOWN);
      await refused.text();
    } finally {
      release();
    }
    try {
      const completed = await pending;
      expect(completed.status).toBe(503);
      expect(completed.headers.has(UNPROCESSED_HEADER)).toBe(false);
      expect(await completed.text()).toBe('processed');
    } finally {
      await stopping;
    }
  });
});
