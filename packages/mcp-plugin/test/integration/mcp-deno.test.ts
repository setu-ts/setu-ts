import { it, expect } from 'vitest';
import { appFor, rpc, rpcResult } from './app.ts';
it('lists and calls a tool through the native runtime adapter', async () => {
  const app = await appFor();
  try {
    const list = await rpcResult(await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect((list.result as { tools: unknown[] }).tools).toHaveLength(1);
    const call = await rpcResult(
      await rpc(app, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'read', arguments: { id: 'native' } },
      }),
    );
    expect((call.result as { content: unknown[] }).content).toEqual([
      { type: 'text', text: '{"id":"native"}' },
    ]);
  } finally {
    await app.stop();
  }
});
