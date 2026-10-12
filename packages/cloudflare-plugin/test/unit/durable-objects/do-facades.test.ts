import { WorkersResponse } from '../../../../../test/node-helpers.ts';
import { afterAll, beforeAll } from 'vitest';
const nativeResponse = globalThis.Response;
beforeAll(() => {
  globalThis.Response = WorkersResponse;
});
afterAll(() => {
  globalThis.Response = nativeResponse;
});
/**
 * `asUpgradeResponse` is the narrowing that turns a bare `TypeError` on
 * `undefined.accept()` into a message naming the binding and what to fix.
 */

import { describe, expect, it } from 'vitest';

import { asUpgradeResponse } from '../../../src/durable-objects/do-facades.ts';
import { CloudflareUnsupportedError } from '../../../src/errors.ts';
import { linkedPair } from '../../do-fakes.ts';

describe('asUpgradeResponse', () => {
  it('narrows a Workers upgrade response, preserving the socket', () => {
    const { client } = linkedPair();

    const upgrade = asUpgradeResponse({ status: 101, webSocket: client }, 'REALTIME');

    expect(upgrade.status).toBe(101);
    expect(upgrade.webSocket).toBe(client);
  });

  it('throws naming the binding when the response carries no socket', () => {
    // What a standard `Response` looks like — the member is silently dropped,
    // which is exactly why this guard exists.
    expect(() => asUpgradeResponse({ status: 200 }, 'REALTIME')).toThrow(
      CloudflareUnsupportedError,
    );

    try {
      asUpgradeResponse({ status: 404 }, 'REALTIME');
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as Error).message).toContain("'REALTIME'");
      expect((error as Error).message).toContain('404');
      expect((error as Error).message).toContain('RealtimeBackplaneObjectCore');
    }
  });

  it('treats an explicitly null socket as absent', () => {
    expect(() => asUpgradeResponse({ status: 101, webSocket: null }, 'REALTIME')).toThrow(
      CloudflareUnsupportedError,
    );
  });

  it('reports an unknown status when the stub answered nothing at all', () => {
    try {
      asUpgradeResponse(undefined, 'REALTIME');
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as Error).message).toContain('unknown');
    }
  });

  it('defaults the status to 101 when the response omits one', () => {
    const { client } = linkedPair();
    expect(asUpgradeResponse({ webSocket: client }, 'REALTIME').status).toBe(101);
  });
});
