import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client } from '@modelcontextprotocol/client';
import { CAPABILITIES, OptionalDependencyUnavailableError } from '@setu-ts/common';
import type { IJwtService } from '@setu-ts/common';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createTestApp } from '@setu-ts/testing';
import { z } from 'zod';
import { createApp } from './setu.config.ts';
import { ItemsResponse } from './src/modules/items/items.schemas.ts';
import { freePort, skip } from '../smoke-helpers.ts';

const sdk = await import('@modelcontextprotocol/client').catch((error: unknown) => {
  if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND')
    skip('Install @modelcontextprotocol/client@^2.4.0 to run the MCP smoke.');
  throw error;
});

async function appFor(max = 60) {
  const previous = process.env.MCP_RATE_MAX;
  process.env.MCP_RATE_MAX = String(max);
  try {
    return await createTestApp({ app: createApp(), without: ['logger-plugin'] });
  } catch (error) {
    if (error instanceof OptionalDependencyUnavailableError) skip(error.message);
    throw error;
  } finally {
    if (previous === undefined) delete process.env.MCP_RATE_MAX;
    else process.env.MCP_RATE_MAX = previous;
  }
}

function token(app: IKernelApplication, scope = 'items:read items:write', sub = 'writer') {
  return app.services.get<IJwtService>(CAPABILITIES.JWT).sign({ sub, scope }, { expiresIn: '5m' });
}

async function clientFor(
  app: IKernelApplication,
  credential: string,
  url = 'http://localhost/mcp',
  socket = false,
) {
  const client = new sdk.Client(
    { name: 'mcp-tools-smoke', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(
    new sdk.StreamableHTTPClientTransport(new URL(url), {
      ...(socket ? {} : { fetch: (input, init) => app.fetch(new Request(input, init)) }),
      requestInit: { headers: { authorization: `Bearer ${credential}` } },
    }),
  );
  return client;
}

function errorText(result: Awaited<ReturnType<Client['callTool']>>) {
  assert.equal(result.isError, true);
  return z
    .array(z.object({ type: z.literal('text'), text: z.string() }))
    .parse(result.content)
    .map((block) => block.text)
    .join('\n');
}

function rpc(app: IKernelApplication, name: string, credential: string) {
  return app.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: { name: 'forbidden' } },
      }),
    }),
  );
}

describe('MCP tools through the scaffolded application', () => {
  it('1: scopes filter the exact tool set and schemas include query, path and output', async () => {
    const app = await appFor();
    try {
      for (const [scope, expected] of [
        ['items:read', ['list_items', 'read_item']],
        ['items:read items:write', ['archive_item', 'create_item', 'list_items', 'read_item']],
      ] as const) {
        const client = await clientFor(app, await token(app, scope));
        try {
          const { tools } = await client.listTools();
          assert.deepEqual(tools.map((tool) => tool.name).sort(), expected);
          const list = tools.find((tool) => tool.name === 'list_items')!;
          assert.equal(list.annotations?.readOnlyHint, true);
          assert.ok(list.inputSchema.properties?.archived);
          const read = tools.find((tool) => tool.name === 'read_item')!;
          assert.ok(read.inputSchema.properties?.id);
          assert.ok(read.outputSchema);
        } finally {
          await client.close();
        }
      }
    } finally {
      await app.stop();
    }
  });

  it('2: create/read round trip returns structured content and a JSON text block; missing reads are isError', async () => {
    const app = await appFor();
    const client = await clientFor(app, await token(app));
    try {
      const created = await client.callTool({
        name: 'create_item',
        arguments: { name: '  Example  ' },
      });
      const item = ItemsResponse.parse(created.structuredContent);
      assert.equal(item.name, 'Example');
      const read = await client.callTool({ name: 'read_item', arguments: { id: item.id } });
      assert.deepEqual(read.structuredContent, item);
      assert.deepEqual(read.content, [{ type: 'text', text: JSON.stringify(item) }]);
      assert.equal(
        errorText(await client.callTool({ name: 'read_item', arguments: { id: 'missing' } })),
        'Not Found: Items not found.',
      );
    } finally {
      await client.close();
      await app.stop();
    }
  });

  it('3: identical create arguments replay and changed arguments create a second record', async () => {
    const app = await appFor();
    const client = await clientFor(app, await token(app));
    try {
      const call = { name: 'create_item', arguments: { name: 'one' } };
      assert.deepEqual(await client.callTool(call), await client.callTool(call));
      const rows = async () =>
        z
          .object({ items: z.array(ItemsResponse) })
          .parse((await client.callTool({ name: 'list_items', arguments: {} })).structuredContent)
          .items;
      assert.equal((await rows()).length, 1);
      await client.callTool({ ...call, arguments: { name: 'two' } });
      assert.equal((await rows()).length, 2);
    } finally {
      await client.close();
      await app.stop();
    }
  });

  it('4: invalid body yields field lines without a stack or mutation', async () => {
    const app = await appFor();
    const client = await clientFor(app, await token(app));
    try {
      const result = await client.callTool({ name: 'create_item', arguments: { name: '' } });
      assert.match(errorText(result), /name:/);
      assert.doesNotMatch(JSON.stringify(result), /stack|at .*\.ts:/);
      assert.deepEqual(
        (await client.callTool({ name: 'list_items', arguments: {} })).structuredContent,
        { items: [] },
      );
    } finally {
      await client.close();
      await app.stop();
    }
  });

  it('5: a hidden single call is outer 403 insufficient_scope; unknown names are -32602', async () => {
    const app = await appFor();
    try {
      const credential = await token(app, 'items:read');
      const refused = await rpc(app, 'create_item', credential);
      assert.equal(refused.status, 403);
      assert.match(refused.headers.get('www-authenticate') ?? '', /insufficient_scope/);
      await refused.text();
      const unknown = await rpc(app, 'unknown', credential);
      assert.equal(unknown.status, 200);
      const body = await unknown.text();
      assert.match(body, /"code":-32602/);
    } finally {
      await app.stop();
    }
  });

  it('6: a per-tool rate limit becomes the exact isError text', async () => {
    const app = await appFor(1);
    const client = await clientFor(app, await token(app));
    try {
      const call = { name: 'list_items', arguments: {} };
      assert.notEqual((await client.callTool(call)).isError, true);
      assert.equal(errorText(await client.callTool(call)), 'Quota Exceeded: Rate limit exceeded');
      // Another route has its own bucket.
      assert.equal(
        errorText(await client.callTool({ name: 'read_item', arguments: { id: 'missing' } })),
        'Not Found: Items not found.',
      );
    } finally {
      await client.close();
      await app.stop();
    }
  });

  it('7: real socket refuses an unlisted Origin before parsing and accepts a client without Origin', async () => {
    // Prove the parsing order before binding too; the same endpoint runs on the socket below.
    const inProcess = await appFor();
    try {
      const refused = await inProcess.fetch(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            Origin: 'https://unlisted.example',
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
          },
          body: '{',
        }),
      );
      assert.equal(refused.status, 403);
      await refused.text();
    } finally {
      await inProcess.stop();
    }

    const app = await createTestApp({
      app: createApp(),
      without: ['logger-plugin'],
      autoStart: false,
    });
    try {
      const port = await freePort();
      await app.start({ port, hostname: '127.0.0.1' });
      const url = `http://127.0.0.1:${port}/mcp`;
      const refused = await fetch(url, {
        method: 'POST',
        headers: {
          Origin: 'https://unlisted.example',
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: '{',
      });
      assert.equal(refused.status, 403);
      await refused.text();
      const client = await clientFor(app, await token(app), url, true);
      try {
        assert.equal((await client.listTools()).tools.length, 4);
      } finally {
        await client.close();
      }
    } finally {
      await app.stop();
    }
  });

  it('8: quota charges once on replay, refuses the second distinct archive, isolates principals and refunds 404', async () => {
    const app = await appFor();
    const client = await clientFor(app, await token(app));
    const other = await clientFor(app, await token(app, 'items:read items:write', 'other'));
    try {
      const create = async (name: string) =>
        ItemsResponse.parse(
          (await client.callTool({ name: 'create_item', arguments: { name } })).structuredContent,
        );
      const one = await create('one');
      const two = await create('two');
      const call = { name: 'archive_item', arguments: { id: one.id, reason: 'done' } };
      const first = await client.callTool(call);
      assert.notEqual(first.isError, true);
      assert.deepEqual(await client.callTool(call), first, 'replay must bypass quota');
      assert.equal(
        errorText(
          await client.callTool({
            name: 'archive_item',
            arguments: { id: two.id, reason: 'done' },
          }),
        ),
        'Quota Exceeded: The quota for this request is spent.',
      );
      assert.equal(
        ItemsResponse.parse(
          (await client.callTool({ name: 'read_item', arguments: { id: two.id } }))
            .structuredContent,
        ).archived,
        false,
      );
      assert.equal(
        errorText(
          await other.callTool({
            name: 'archive_item',
            arguments: { id: 'missing', reason: 'done' },
          }),
        ),
        'Not Found: Items not found.',
      );
      assert.notEqual(
        (await other.callTool({ name: 'archive_item', arguments: { id: two.id, reason: 'done' } }))
          .isError,
        true,
      );
      const archived = await client.callTool({
        name: 'list_items',
        arguments: { archived: 'true' },
      });
      assert.equal(
        z.object({ items: z.array(ItemsResponse) }).parse(archived.structuredContent).items.length,
        2,
      );
      const independent = await appFor();
      const fresh = await clientFor(independent, await token(independent));
      try {
        assert.deepEqual(
          (await fresh.callTool({ name: 'list_items', arguments: {} })).structuredContent,
          { items: [] },
        );
        // Same principal in another app still reaches the handler (404, not spent).
        assert.equal(
          errorText(
            await fresh.callTool({
              name: 'archive_item',
              arguments: { id: 'missing', reason: 'done' },
            }),
          ),
          'Not Found: Items not found.',
        );
      } finally {
        await fresh.close();
        await independent.stop();
      }
    } finally {
      await other.close();
      await client.close();
      await app.stop();
    }
  });
});
