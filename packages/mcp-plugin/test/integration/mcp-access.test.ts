import { it, expect, vi } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IJwtService } from '@setu-ts/common';
import { AuthPlugin, requireScopes } from '@setu-ts/auth-plugin';
import { appFor, clientFor, rpc, rpcResult } from './app.ts';

it('filters two principals, sends private cache hints, and short circuits hidden calls with Bearer challenges', async () => {
  const handler = vi.fn((ctx) => ctx.response.json({ ok: true }));
  const app = await appFor({}, { middleware: [requireScopes('tools:read')], handler }, [
    AuthPlugin({
      jwt: { secret: 'm133-test-secret-at-least-32-characters' },
      resourceServer: { resource: 'http://localhost', scopesSupported: ['tools:read'] },
    }),
  ]);
  try {
    const jwt = app.services.get<IJwtService>(CAPABILITIES.JWT);
    const read = await jwt.sign({ sub: 'reader', scope: 'tools:read' });
    const other = await jwt.sign({ sub: 'other', scope: 'tools:write' });
    for (const [token, count] of [
      [read, 1],
      [other, 0],
    ] as const) {
      const { client, responses } = await clientFor(app, 'modern', {
        authorization: `Bearer ${token}`,
      });
      try {
        expect((await client.listTools()).tools).toHaveLength(count);
        const list = await rpcResult(responses[responses.length - 1]!);
        expect(JSON.stringify(list)).toContain('private');
        expect(JSON.stringify(list)).not.toContain('"cacheScope":"public"');
      } finally {
        await client.close();
      }
    }
    for (const [headers, status, challenge] of [
      [{}, 401, 'Bearer'],
      [{ authorization: `Bearer ${other}` }, 403, 'insufficient_scope'],
    ] as const) {
      const r = await rpc(
        app,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'read', arguments: { id: 'x' } },
        },
        headers,
      );
      expect(r.status).toBe(status);
      expect(r.headers.get('www-authenticate')).toContain(challenge);
      if (status === 403) expect(r.headers.get('www-authenticate')).toContain('tools:read');
      await r.text();
    }
    expect(handler).not.toHaveBeenCalled();
    const unknown = await rpcResult(
      await rpc(app, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'unknown', arguments: {} },
      }),
    );
    expect(unknown.error).toMatchObject({ code: -32602 });
    expect(handler).not.toHaveBeenCalled();
    const batch = await rpcResult(
      await rpc(app, [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'read', arguments: { id: 'x' } },
        },
      ]),
    );
    expect(handler).not.toHaveBeenCalled();
    expect(Array.isArray(batch) ? batch[0] : batch).toMatchObject({ error: { code: -32602 } });
  } finally {
    await app.stop();
  }
});
