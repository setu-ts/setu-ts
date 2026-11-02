import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { IPlugin, RouteDefinition } from '@setu-ts/common';
import { McpPlugin } from '../../src/index.ts';
import type { McpPluginOptions } from '../../src/index.ts';
import { declaration, BASE } from '../fixtures.ts';
export async function appFor(
  options: Partial<McpPluginOptions> = {},
  definition: Partial<RouteDefinition> = {},
  plugins: IPlugin[] = [],
): Promise<IKernelApplication> {
  const app = createApplication({
    plugins: [RuntimePlugin(), ...plugins, McpPlugin({ tools: [declaration], ...options })],
  });
  app.router.get('/items/:id', {
    handler: (ctx) => ctx.response.json({ id: ctx.params.id }),
    ...definition,
  });
  await app.start();
  return app;
}
export async function clientFor(
  app: IKernelApplication,
  mode: 'legacy' | 'modern' = 'modern',
  headers: Record<string, string> = {},
) {
  const client = new Client(
    { name: 'test', version: '1' },
    { versionNegotiation: { mode: mode === 'modern' ? { pin: '2026-07-28' } : 'legacy' } },
  );
  const responses: Response[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: async (input, init) => {
      const response = await app.fetch(new Request(input, init));
      responses.push(response.clone());
      return response;
    },
    requestInit: { headers },
  });
  await client.connect(transport);
  return { client, transport, responses };
}
export async function rpc(
  app: IKernelApplication,
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return await app.fetch(
    new Request(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    }),
  );
}
export async function rpcResult(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const json = text.startsWith('event:') ? text.split('data: ')[1]!.split('\n')[0]! : text;
  return JSON.parse(json) as Record<string, unknown>;
}
