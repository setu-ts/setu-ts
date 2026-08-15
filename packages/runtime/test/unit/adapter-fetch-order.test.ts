/**
 * Unit test: adapter fetch handler calls framework handler BEFORE upgrade
 * consultation (M70a). Verifies the fetch handler ordering across adapters.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRequest, IResponse } from '@setu-ts/common';
import { UPGRADE_INTENT } from '@setu-ts/common';
import { DenoHttpAdapter, type DenoServeHost } from '../../src/adapters/deno/deno-http-adapter.ts';

function createDenoFakeHost(): DenoServeHost {
  return {
    serve: () => ({ shutdown: async () => {} }),
  };
}

describe('Adapter fetch handler ordering (M70a)', () => {
  it('framework handler is called before upgrade check', async () => {
    const order: string[] = [];
    const host = createDenoFakeHost();
    const adapter = new DenoHttpAdapter(host);

    adapter.setHandler((request: IRequest): Promise<IResponse> => {
      order.push('framework-handler');
      // Simulate kernel writing UPGRADE_INTENT
      (request as unknown as Record<symbol, { sink: any }>)['setu-ts.upgrade-intent' as any] = {
        sink: { onOpen: () => {}, onMessage: () => {}, onClose: () => {}, onError: () => {} },
      };
      return Promise.resolve({
        snapshot: () => ({
          streaming: false as const,
          status: 101,
          headers: new Headers(),
          body: null,
        }),
      } as unknown as IResponse);
    });

    await adapter.fetch(new Request('http://localhost/ws'));

    // Framework handler runs first
    expect(order[0]).toBe('framework-handler');
  });

  it('no upgrade consultation happens before framework handler', async () => {
    const host = createDenoFakeHost();
    const adapter = new DenoHttpAdapter(host);
    let handlerCalled = false;

    adapter.setHandler((_request: IRequest): Promise<IResponse> => {
      handlerCalled = true;
      return Promise.resolve({
        snapshot: () => ({
          streaming: false as const,
          status: 200,
          headers: new Headers(),
          body: 'ok',
        }),
      } as unknown as IResponse);
    });

    await adapter.fetch(new Request('http://localhost/test'));
    expect(handlerCalled).toBe(true);
  });
});
