import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ClientResponse, IHttpClient } from '../../src/index.ts';
import { createApi } from '../fixtures/generated-client.ts';

describe('generated-client e2e', () => {
  it('uses the generated factory with a fake client', async () => {
    let lastRequest: unknown = null;
    const fakeClient: IHttpClient = {
      request: async <T>(_req: unknown) => {
        lastRequest = _req;
        await Promise.resolve();
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          data: { id: '1', name: 'Test User' } as unknown as T,
        };
      },
    };

    const api = createApi(fakeClient);
    const resp: ClientResponse<{ id: string; name: string }> = await api.getUserById('1');

    expect(lastRequest).toEqual({
      method: 'GET',
      path: '/users/1',
    });
    expect(resp.data).toEqual({
      id: '1',
      name: 'Test User',
    });
  });

  it('forwards query params through generated code', async () => {
    let lastRequest: unknown = null;
    const fakeClient: IHttpClient = {
      request: async <T>(_req: unknown) => {
        lastRequest = _req;
        await Promise.resolve();
        return {
          status: 200,
          headers: new Headers(),
          data: [] as unknown as T,
        };
      },
    };

    const api = createApi(fakeClient);
    await api.listUsers({ page: 2, limit: 10 });

    expect(lastRequest).toEqual({
      method: 'GET',
      path: '/users',
      query: { page: 2, limit: 10 },
    });
  });
});
