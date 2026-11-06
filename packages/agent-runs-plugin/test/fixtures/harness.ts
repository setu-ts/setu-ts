import { vi } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  AgentRunRow,
  IIdempotencyService,
  IRuntimeServices,
  AgentRunEntryRow,
  IPluginContext,
} from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import {
  DatabasePlugin,
  createDatabaseAgentRunStore,
  createDatabaseIdempotencyStore,
} from '@setu-ts/database-plugin';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { IdempotencyPlugin } from '@setu-ts/idempotency-plugin';
import { createNodeRuntimeServices, RuntimePlugin } from '@setu-ts/runtime';
import { createTestContext } from '@setu-ts/testing';
import { defineAgentRun } from '../../src/index.ts';
import type { AgentRunDefinition } from '../../src/index.ts';
import { AgentRunService } from '../../src/service/agent-run-service.ts';
import { resolveOptions } from '../../src/plugin/agent-runs-plugin.ts';
import { loadAi } from '../../src/runtime/ai-runtime.ts';
import type { AiRuntime } from '../../src/runtime/ai-runtime.ts';

export function clock() {
  let now = 1_000_000;
  const timers = new Map<object, { fn: () => void; ms: number; interval: boolean }>();
  const arm = (fn: () => void, ms: number, interval: boolean): object => {
    const handle = {};
    timers.set(handle, { fn, ms, interval });
    return handle;
  };
  const runtime: IRuntimeServices = {
    ...createNodeRuntimeServices(),
    now: () => now,
    setTimeout: (fn, ms) => arm(fn, ms, false),
    setInterval: (fn, ms) => arm(fn, ms, true),
    clearTimeout: (handle) => {
      timers.delete(handle as object);
    },
    clearInterval: (handle) => {
      timers.delete(handle as object);
    },
  };
  return {
    runtime,
    timers,
    advance: (ms: number) => {
      now += ms;
    },
    fire: (ms: number) => {
      for (const [handle, timer] of [...timers])
        if (timer.ms <= ms) {
          if (!timer.interval) timers.delete(handle);
          timer.fn();
        }
    },
  };
}
export function row(overrides: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: 'run',
    tenantId: 'tenant',
    principalId: 'user',
    definition: 'demo',
    version: '1',
    status: 'running',
    input: [{ role: 'user', content: 'hi' }],
    leaseOwner: '',
    leaseVersion: 0,
    leaseUntil: 0,
    entryCount: 0,
    approvalIds: [],
    chunkCount: 0,
    stepChunkStart: 0,
    toolTimeoutKey: '',
    toolTimeouts: 0,
    cancelRequested: false,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
export function entry(
  run: AgentRunRow,
  overrides: Partial<AgentRunEntryRow> = {},
): AgentRunEntryRow {
  return {
    id: `${run.id}.${String(run.entryCount).padStart(12, '0')}`,
    runId: run.id,
    tenantId: run.tenantId,
    seq: run.entryCount,
    kind: 'model',
    messages: [{ role: 'assistant', content: 'hello' }],
    finishReason: 'stop',
    usage: {},
    toolCallId: null,

    stepChunkStart: null,
    ...overrides,
  };
}
export const model = 'provider/model';
export function definition(overrides: Partial<AgentRunDefinition> = {}): AgentRunDefinition {
  return defineAgentRun({
    name: 'demo',
    version: '1',
    model: () => model,
    maxOutputTokens: 100,
    ...overrides,
  });
}
export function fakeAi(
  replies: {
    messages: import('ai').ModelMessage[];
    finishReason: string;
    usage: unknown;
    chunks?: import('ai').UIMessageChunk[];
  }[] = [{ messages: [{ role: 'assistant', content: 'hello' }], finishReason: 'stop', usage: {} }],
): AiRuntime & { model: ReturnType<typeof vi.fn<AiRuntime['model']>> } {
  let index = 0;
  return {
    headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
    model: vi.fn(() => {
      const reply = replies[index++] ?? replies.at(-1)!;
      return {
        chunks: new ReadableStream({
          start(controller) {
            for (const chunk of reply.chunks ?? [
              { type: 'start-step' },
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: 'hello' },
              { type: 'text-end', id: 't' },
              { type: 'finish-step' },
            ])
              controller.enqueue(chunk);
            controller.close();
          },
        }),
        result: () => Promise.resolve(reply),
      };
    }),
  };
}
export async function harness(def = definition(), ai: AiRuntime = fakeAi()) {
  const time = clock();
  let pluginContext: IPluginContext | undefined;
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      {
        name: 'capture-context',
        version: '1',
        register(ctx) {
          pluginContext = ctx;
        },
      },
      DatabasePlugin({ type: 'memory' }),
      IdempotencyPlugin({
        transactional: { store: createDatabaseIdempotencyStore(), purge: { schedule: false } },
      }),
    ],
  });
  await app.start();
  const services = app.services;
  const store = await createDatabaseAgentRunStore()(services);
  const db = services.get<IDatabaseService>(CAPABILITIES.DATABASE);
  const deps = {
    store,
    runtime: time.runtime,
    services,
    idempotency: services.get<IIdempotencyService>(CAPABILITIES.IDEMPOTENCY),
    ai,
    definitions: new Map([[def.name, def]]),
    options: resolveOptions({ store, definitions: [def] }),
  };
  const service = new AgentRunService(deps);
  const ctx = (tenant = 'tenant', principal = 'user', headers = new Headers()) =>
    createTestContext({
      services,
      runtime: time.runtime,
      request: {
        headers,
        ...(tenant ? { tenant: { id: tenant } } : {}),
        ...(principal ? { user: { id: principal } } : {}),
      },
    });
  return {
    app,
    db,
    store,
    deps,
    service,
    pluginContext: pluginContext!,
    ctx,
    ...time,
    settle: async () => {
      while (service.work.size) await Promise.all([...service.work]);
    },
    close: async () => {
      service.close();
      await app.stop();
    },
  };
}
export { loadAi };
