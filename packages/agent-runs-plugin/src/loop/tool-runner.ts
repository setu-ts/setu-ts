import { httpStatusHintOf } from '@setu-ts/common';
import type { AgentRunJson, IIdempotencyService, IRuntimeServices } from '@setu-ts/common';
import type { ModelMessage, ToolExecutionOptions, ToolSet } from 'ai';
import type { AgentRunContext, AgentRunDefinition } from '../definitions/define-agent-run.ts';
import { json } from './messages.ts';

/** Private marker preserves rollback and distinguishes application failures. @internal */
class ToolFailure extends Error {
  constructor(cause: unknown) {
    super('Agent tool failed.', { cause });
  }
}
/** A concurrent within holder stops execution for the next sweep. @internal */
export class ToolConflict extends Error {}
/** SHA-256 encodes the run, model entry index and call id without ambiguity. @internal */
export async function toolKey(
  runtime: IRuntimeServices,
  runId: string,
  entry: number,
  call: string,
): Promise<string> {
  const hash = await runtime.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([runId, entry, call])),
  );
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** Validate SDK context via its public Standard Schema / Schema contracts. @internal */
async function contextFor(schema: unknown, value: unknown): Promise<unknown> {
  if (schema === undefined) return value;
  const actual: unknown = typeof schema === 'function' ? (schema as () => unknown)() : schema;
  if (!actual || typeof actual !== 'object') throw new TypeError('Invalid tool context schema.');
  const standard = (actual as { '~standard'?: { validate?: (value: unknown) => unknown } })[
    '~standard'
  ];
  if (standard?.validate) {
    const result = (await standard.validate(value)) as { value?: unknown; issues?: unknown };
    if (result.issues) throw new TypeError('Invalid tool context.');
    return result.value;
  }
  const validate = (actual as { validate?: (value: unknown) => unknown }).validate;
  if (validate) {
    const result = (await validate(value)) as { success: boolean; value?: unknown };
    if (!result.success) throw new TypeError('Invalid tool context.');
    return result.value;
  }
  const safeParse = (
    actual as { safeParseAsync?: (value: unknown) => Promise<{ success: boolean; data?: unknown }> }
  ).safeParseAsync;
  if (safeParse) {
    const result = await safeParse.call(actual, value);
    if (!result.success) throw new TypeError('Invalid tool context.');
    return result.data;
  }
  // SDK Schema.validate is optional: JSON Schema alone describes, rather
  // than validates, context (provider-utils safeValidateTypes semantics).
  if ('jsonSchema' in actual) return value;
  throw new TypeError('Tool context schema has no validator.');
}
/** Execute inside within; only tool exceptions become model-visible error results. @internal */
export async function runTool(
  deps: { runtime: IRuntimeServices; idempotency: IIdempotencyService },
  definition: AgentRunDefinition,
  run: AgentRunContext,
  entryIndex: number,
  call: { toolCallId: string; toolName: string; input: AgentRunJson },
  history: ModelMessage[],
): Promise<{ output: AgentRunJson; error: boolean }> {
  const key = await toolKey(deps.runtime, run.runId, entryIndex, call.toolCallId);
  try {
    const result = await deps.idempotency.within(
      {
        namespace: 'setu.agent-runs.tool',
        scope: JSON.stringify([run.tenantId, run.principalId ?? '']),
        key,
        fingerprint: { tool: call.toolName, input: call.input },
      },
      async (unitOfWork: unknown) => {
        try {
          const tool: ToolSet[string] | undefined = definition.tools?.[call.toolName];
          if (!tool?.execute) throw new Error('Tool unavailable.');
          const context = definition.toolsContext?.(run, {
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            idempotencyKey: key,
            unitOfWork,
          })?.[call.toolName];
          const options: ToolExecutionOptions<unknown> = {
            toolCallId: call.toolCallId,
            messages: history,
            abortSignal: run.signal,
            context: await contextFor(tool.contextSchema, context),
          };
          const produced: unknown = await tool.execute(call.input, options);
          let output: unknown = produced;
          if (
            produced !== null &&
            typeof produced === 'object' &&
            Symbol.asyncIterator in produced
          ) {
            output = null;
            for await (const value of produced as AsyncIterable<unknown>) output = value;
          }
          run.signal.throwIfAborted();
          return output;
        } catch (cause) {
          throw new ToolFailure(cause);
        }
      },
    );
    return { output: json(result.value), error: false };
  } catch (error) {
    if (error instanceof ToolFailure) return { output: 'Agent tool failed.', error: true };
    if (httpStatusHintOf(error)?.status === 409) throw new ToolConflict();
    throw error;
  }
}
