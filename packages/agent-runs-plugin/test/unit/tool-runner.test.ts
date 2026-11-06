import { describe, it, expect, vi } from 'vitest';
import { jsonSchema } from 'ai';
import { withHttpStatusHint } from '@setu-ts/common';
import type { IUnitOfWork } from '@setu-ts/database-plugin';
import { z } from 'zod';
import { z as z3 } from 'zod/v3';
import { harness, definition } from '../fixtures/harness.ts';
import { runTool, toolKey, ToolConflict } from '../../src/loop/tool-runner.ts';
describe('transactional tool runner', () => {
  it('derives a stable key, supplies only its context and replays once', async () => {
    const h = await harness();
    try {
      const context = {
        runId: 'run',
        tenantId: 'tenant',
        principalId: 'user',
        services: h.deps.services,
        signal: new AbortController().signal,
      };
      const call = { toolCallId: 'c', toolName: 'act', input: { amount: 1 } };
      const execute = vi.fn(
        async (input: unknown, options: import('ai').ToolExecutionOptions<unknown>) => {
          expect(input).toEqual(call.input);
          expect(options.context).toEqual({ key: await toolKey(h.runtime, 'run', 0, 'c') });
          expect(options.messages).toEqual([]);
          return 'ok';
        },
      );
      const d = definition({
        tools: {
          act: {
            inputSchema: jsonSchema({}),
            contextSchema: z.object({ key: z.string() }),
            execute,
          },
        },
        toolsContext: (run, info) => {
          expect(run.tenantId).toBe('tenant');
          expect(run.principalId).toBe('user');
          expect(info.unitOfWork).toHaveProperty('getRepository');
          expect(Object.keys(info).sort()).toEqual([
            'idempotencyKey',
            'toolCallId',
            'toolName',
            'unitOfWork',
          ]);
          return { act: { key: info.idempotencyKey }, other: 'secret' };
        },
      });
      expect(await runTool(h.deps, d, context, 0, call, [])).toEqual({
        output: 'ok',
        error: false,
      });
      await runTool(h.deps, d, context, 0, call, []);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await toolKey(h.runtime, 'run', 1, 'c')).not.toBe(
        await toolKey(h.runtime, 'run', 0, 'c'),
      );
    } finally {
      await h.close();
    }
  });
  it('drains preliminary results and rolls back errors with a safe result', async () => {
    const h = await harness();
    try {
      const context = {
        runId: 'run',
        tenantId: 'tenant',
        principalId: null,
        services: h.deps.services,
        signal: new AbortController().signal,
      };
      const tool = {
        inputSchema: jsonSchema({}),
        execute: async function* () {
          yield 1;
          yield 2;
        },
      };
      expect(
        await runTool(
          h.deps,
          definition({ tools: { act: tool } }),
          context,
          0,
          { toolCallId: 'stream', toolName: 'act', input: {} },
          [],
        ),
      ).toEqual({ output: 2, error: false });
      const d = definition({
        tools: {
          act: {
            inputSchema: jsonSchema({}),
            execute: async (_input: unknown, opts: import('ai').ToolExecutionOptions<unknown>) => {
              await (opts.context as IUnitOfWork).getRepository('Business').create({ id: 'write' });
              throw new Error('secret');
            },
          },
        },
        toolsContext: (_run, call) => ({ act: call.unitOfWork }),
      });
      expect(
        await runTool(
          h.deps,
          d,
          context,
          0,
          { toolCallId: 'throw', toolName: 'act', input: {} },
          [],
        ),
      ).toEqual({ output: 'Agent tool failed.', error: true });
      expect(await h.db.getRepository('Business').count()).toBe(0);
      expect(
        (
          await runTool(
            h.deps,
            definition(),
            context,
            0,
            { toolCallId: 'absent', toolName: 'absent', input: {} },
            [],
          )
        ).error,
      ).toBe(true);
    } finally {
      await h.close();
    }
  });
  it('classifies within errors and validates SDK context shapes', async () => {
    const h = await harness();
    try {
      const context = {
        runId: 'run',
        tenantId: '',
        principalId: null,
        services: h.deps.services,
        signal: new AbortController().signal,
      };
      const call = { toolCallId: 'c', toolName: 'act', input: {} };
      const conflict = withHttpStatusHint(new Error(), {
        status: 409,
        title: 'Conflict',
        detail: 'Conflict.',
      });
      const spy = vi
        .spyOn(h.deps.idempotency, 'within')
        .mockRejectedValueOnce(conflict)
        .mockRejectedValueOnce(new Error('store'));
      await expect(runTool(h.deps, definition(), context, 0, call, [])).rejects.toBeInstanceOf(
        ToolConflict,
      );
      await expect(runTool(h.deps, definition(), context, 0, call, [])).rejects.toThrow('store');
      spy.mockRestore();
      const schemas: unknown[] = [
        () => jsonSchema({}, { validate: (value) => ({ success: true, value }) }),
        z.string(),
        null,
        { validate: () => ({ success: false }) },
        { validate: () => ({ success: true, value: 'changed' }) },
        {},
        jsonSchema({}),
        z3.string().optional(),
        z3.string(),
      ];
      for (let i = 0; i < schemas.length; i++) {
        const d = definition({
          tools: {
            act: {
              inputSchema: jsonSchema({}),
              contextSchema: schemas[i] as never,
              execute: (_input, options) => options.context ?? null,
            },
          },
        });
        const result = await runTool(h.deps, d, context, i, call, []);
        expect(result.error).toBe(![0, 4, 6, 7].includes(i));
      }
    } finally {
      await h.close();
    }
  });
});
