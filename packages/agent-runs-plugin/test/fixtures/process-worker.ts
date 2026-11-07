import { MockLanguageModelV4 } from 'ai/test';
import { jsonSchema } from 'ai';
import { CAPABILITIES } from '@setu-ts/common';
import type { IIdempotencyService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin, createNodeRuntimeServices } from '@setu-ts/runtime';
import {
  DatabasePlugin,
  createDatabaseIdempotencyStore,
  DatabaseAgentRunStore,
} from '@setu-ts/database-plugin';
import type { IUnitOfWork } from '@setu-ts/database-plugin';
import { IdempotencyPlugin } from '@setu-ts/idempotency-plugin';
import { createTestContext } from '@setu-ts/testing';
import { agentRunPostgres } from '../../../database-plugin/test/fixtures/agent-run-postgres.ts';
import { defineAgentRun } from '../../src/index.ts';
import { AgentRunService } from '../../src/service/agent-run-service.ts';
import { loadAi } from '../../src/runtime/ai-runtime.ts';
import { resolveOptions } from '../../src/plugin/agent-runs-plugin.ts';

const h = await agentRunPostgres(
  process.env['AGENT_RUNS_PG_URL']!,
  process.env['AGENT_RUNS_SCHEMA']!,
);
const app = createApplication({
  plugins: [
    RuntimePlugin(),
    DatabasePlugin({ type: 'custom', adapter: h.adapter }),
    IdempotencyPlugin({
      transactional: { store: createDatabaseIdempotencyStore(), purge: { schedule: false } },
    }),
  ],
});
await app.start();
const runtime = createNodeRuntimeServices();
const model = new MockLanguageModelV4({
  doStream: async () => {
    await h.database.getRepository('ModelCalls').create({ id: runtime.uuid(), name: 'called' });
    return {
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          c.enqueue({ type: 'tool-call', toolCallId: 'c', toolName: 'act', input: '{}' });
          c.enqueue({
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          });
          c.close();
        },
      }),
    };
  },
});
const definition = defineAgentRun({
  name: 'demo',
  version: '1',
  model: () => model,
  maxSteps: 1,
  maxOutputTokens: 10,
  tools: {
    act: {
      inputSchema: jsonSchema({ type: 'object' }),
      execute: async (_input: unknown, options: import('ai').ToolExecutionOptions<unknown>) => {
        await (options.context as IUnitOfWork)
          .getRepository('Business')
          .create({ id: 'effect', name: 'once' });
        return 'ok';
      },
    },
  },
  toolsContext: (_run, call) => ({ act: call.unitOfWork }),
});
const store = new DatabaseAgentRunStore(h.database);
const mode = process.argv[2];
const service = new AgentRunService({
  store,
  runtime,
  services: app.services,
  idempotency: app.services.get<IIdempotencyService>(CAPABILITIES.IDEMPOTENCY),
  ai: await loadAi(),
  definitions: new Map([['demo', definition]]),
  options: resolveOptions({ store, definitions: [definition], leaseMs: 30, maxClockSkewMs: 0 }),
  ...(mode === 'first'
    ? {
        hooks: {
          afterModelEntry: async () => {
            process.stdout.write('COMMITTED\n');
            await new Promise<void>(() => {});
          },
        },
      }
    : {}),
});
if (mode === 'first')
  await service.start(createTestContext({ services: app.services }), 'demo', {
    messages: [{ role: 'user', content: 'Hi' }],
  });
else {
  await service.sweep();
  await Promise.all([...service.work]);
  process.stdout.write('RESUMED\n');
  service.close();
  await app.stop();
  await h.close();
}
