import { describe, expect, it } from 'vitest';
import { AuthPlugin, requireAuth, requireScopes } from '@setu-ts/auth-plugin';
import { getSession, SessionPlugin } from '@setu-ts/session-plugin';
import { z } from 'zod-v4';
import { ValidationPlugin, validateBody } from '@setu-ts/validation-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { McpPlugin } from '../../src/index.ts';
import { appFor, clientFor, rpc } from './app.ts';

describe('M139a MCP form CSRF composition', () => {
  it('exempts an outer cookie call while its inner POST still requires CSRF', async () => {
    let writes = 0;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ValidationPlugin(),
        SessionPlugin({
          secret: 'm139a-session-secret-at-least-32-characters',
          csrf: {},
          cookie: { secure: false },
        }),
        AuthPlugin({
          session: { toPrincipal: (session) => (session.data.user ? { id: 'u1' } : null) },
        }),
        McpPlugin({
          tools: [
            {
              name: 'write',
              description: 'Write a record',
              repeatable: true,
              route: { method: 'POST', path: '/write' },
            },
          ],
        }),
      ],
    });
    app.router.get('/seed', (ctx) => {
      getSession(ctx).set('user', true);
      return ctx.response.send();
    });
    app.router.post('/write', {
      middleware: [requireAuth(), validateBody(z.object({}))],
      handler: (ctx) => {
        writes++;
        return ctx.response.json({ ok: true });
      },
    });
    await app.start();
    try {
      const seed = await app.fetch(new Request('http://localhost/seed'));
      const cookie = seed.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      await seed.text();
      const initialized = await rpc(
        app,
        {
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: '2026-07-28',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' },
          },
        },
        { cookie },
      );
      expect(initialized.status).toBe(200);
      await initialized.text();
      const { client, responses } = await clientFor(app, 'modern', { cookie });
      try {
        const result = await client.callTool({ name: 'write', arguments: {} });
        expect(result.isError).toBe(true);
        expect(writes).toBe(0);
        expect(responses.every((response) => response.headers.get('set-cookie') === null)).toBe(
          true,
        );
      } finally {
        await client.close();
      }
    } finally {
      await app.stop();
    }
  });
  it('challenges anonymous calls, preserves Origin and other-path refusals, and emits no cookie', async () => {
    const app = await appFor({}, { middleware: [requireScopes('tools:read')] }, [
      SessionPlugin({ secret: ['m139a-session-secret-at-least-32-characters'], csrf: {} }),
      AuthPlugin({
        jwt: { secret: 'm139a-token-secret' },
        resourceServer: { resource: 'http://localhost' },
      }),
    ]);
    try {
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read', arguments: { id: 'x' } },
      };
      const response = await rpc(app, body);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('Bearer');
      expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
      expect(response.headers.get('set-cookie')).toBeNull();
      await response.text();
      const crossSite = await rpc(app, body, { origin: 'https://evil.test' });
      expect(crossSite.status).toBe(403);
      expect(crossSite.headers.get('set-cookie')).toBeNull();
      await crossSite.text();
      for (const path of ['/other', '/mcp/', '/MCP', '/%6Dcp', '/mcp/extra']) {
        const refused = await app.inject({
          method: 'POST',
          url: path,
          headers: {
            'content-type': 'application/json',
            'x-csrf-exempt': 'true',
          },
          body: JSON.stringify(body),
        });
        expect(refused.statusCode).toBe(403);
      }
    } finally {
      await app.stop();
    }
  });
});
