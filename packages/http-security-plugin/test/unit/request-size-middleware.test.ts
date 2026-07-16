// deno-lint-ignore-file require-await -- test fixtures use sync methods matching async interface signatures
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { requestSizeMiddleware } from '../../src/middleware/request-size-middleware.ts';
import { createFakeContext } from '../fixtures/fake-request-context.ts';

describe('requestSizeMiddleware', () => {
  describe('enabled: false', () => {
    it('returns pass-through middleware', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: { headers: { 'Content-Length': '999999999' } },
      });
      const mw = requestSizeMiddleware({ enabled: false });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('Content-Length over limit', () => {
    it('returns 413 and does not call next()', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: { headers: { 'Content-Length': '2097152' } },
      });
      const mw = requestSizeMiddleware({ maxBodySize: 1_048_576 });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(413);
      const body = response.body as { error: string; message: string };
      expect(body.error).toBe('Payload Too Large');
      expect(body.message).toContain('2097152');
      expect(body.message).toContain('1048576');
    });
  });

  describe('Content-Length at/under limit', () => {
    it('passes through at exact limit', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: { headers: { 'Content-Length': '1048576' } },
      });
      const mw = requestSizeMiddleware({ maxBodySize: 1_048_576 });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });

    it('passes through under limit', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: { headers: { 'Content-Length': '500' } },
      });
      const mw = requestSizeMiddleware({ maxBodySize: 1_048_576 });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('absent Content-Length', () => {
    it('passes through when no Content-Length', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: { headers: {} },
      });
      const mw = requestSizeMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('malformed Content-Length', () => {
    it('passes through for non-numeric Content-Length', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: { headers: { 'Content-Length': 'abc' } },
      });
      const mw = requestSizeMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });

    it('passes through for negative Content-Length', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: { headers: { 'Content-Length': '-1' } },
      });
      const mw = requestSizeMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });

    it('passes through for NaN Content-Length', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: { headers: { 'Content-Length': 'NaN' } },
      });
      const mw = requestSizeMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('default maxBodySize', () => {
    it('uses 1 MiB default when maxBodySize omitted', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: { headers: { 'Content-Length': '1048577' } },
      });
      const mw = requestSizeMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(413);
    });

    it('passes at exactly 1 MiB with default', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: { headers: { 'Content-Length': '1048576' } },
      });
      const mw = requestSizeMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });
});
