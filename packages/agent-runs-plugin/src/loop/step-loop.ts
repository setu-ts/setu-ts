import type {
  AgentRunEntryRow,
  IIdempotencyService,
  ILogger,
  IServiceRegistry,
  TimerHandle,
} from '@setu-ts/common';
import { AgentRunLeaseLostError, httpStatusHintOf } from '@setu-ts/common';
import type { AgentRunContext, AgentRunDefinition } from '../definitions/define-agent-run.ts';
import type { AiRuntime } from '../runtime/ai-runtime.ts';
import type { Lease } from '../lease/lease.ts';
import type { ChunkLog } from '../log/chunk-log.ts';
import { prepareApprovals } from '../approvals/approvals.ts';
import { calls, childId, json, messages, schemaOnly } from './messages.ts';
import { runTool, ToolConflict } from './tool-runner.ts';

/** Internal crash seam; never exported from the package barrel. @internal */
export interface LoopHooks {
  readonly afterModelEntry?: (entry: AgentRunEntryRow) => Promise<void>;
  readonly afterToolEntry?: (entry: AgentRunEntryRow) => Promise<void>;
}
/** Bound a call with runtime timers, linked to holder cancellation. @internal */
async function timed<T>(
  lease: Lease,
  ms: number | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(lease.controller.signal.reason);
  lease.controller.signal.addEventListener('abort', abort, { once: true });
  if (lease.controller.signal.aborted) abort();
  let timer: TimerHandle | undefined;
  if (ms !== undefined)
    timer = lease.runtime.setTimeout(
      () => controller.abort(new Error('Agent call timed out.')),
      ms,
    );
  try {
    controller.signal.throwIfAborted();
    // Race ensures a tool ignoring its signal cannot keep the holder alive forever.
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      }),
    );
    return await Promise.race([work(controller.signal), aborted]);
  } finally {
    if (timer !== undefined) lease.runtime.clearTimeout(timer);
    lease.controller.signal.removeEventListener('abort', abort);
  }
}
/** Drive SDK model calls and fenced, idempotent tools one persisted entry at a time. @internal */
export async function stepLoop(
  lease: Lease,
  log: ChunkLog,
  definition: AgentRunDefinition | undefined,
  deps: {
    ai: AiRuntime;
    idempotency: IIdempotencyService;
    services: IServiceRegistry;
    logger?: ILogger;
    hooks?: LoopHooks;
  },
): Promise<void> {
  const context: AgentRunContext = {
    runId: lease.row.id,
    tenantId: lease.row.tenantId,
    principalId: lease.row.principalId,
    services: deps.services,
    signal: lease.controller.signal,
  };
  try {
    await log.restore();
    if (
      !definition ||
      (definition.version !== lease.row.version &&
        !definition.compatibleVersions?.includes(lease.row.version))
    ) {
      deps.logger?.warn('Agent run failed.', {
        definition: lease.row.definition,
        error: 'version-incompatible',
      });
      await log.emit({ type: 'error', errorText: 'Agent run definition is incompatible.' });
      await log.flush();
      await lease.write({
        status: 'failed',
        error: 'version-incompatible',
        leaseOwner: '',
        leaseUntil: 0,
      });
      return;
    }
    const entries = [...(await lease.store.entries(lease.row))];
    const lastModel = entries.filter((entry) => entry.kind === 'model').at(-1);
    if (lease.row.chunkCount === 0) await log.emit({ type: 'start', messageId: lease.row.id });
    else if (
      lastModel?.stepChunkStart !== lease.row.stepChunkStart &&
      lease.row.chunkCount > lease.row.stepChunkStart
    )
      await log.emit({ type: 'reset-step' });
    while (true) {
      await lease.renew();
      const modelEntries = entries.filter((entry) => entry.kind === 'model');
      const modelEntry = modelEntries.at(-1);
      if (modelEntry) {
        const pendingCalls = calls(modelEntry).filter(
          (call) =>
            !entries.some(
              (entry) =>
                entry.seq > modelEntry.seq &&
                entry.kind === 'tool' &&
                entry.toolCallId === call.toolCallId,
            ),
        );
        if (pendingCalls.length > 0) {
          const approvals = await prepareApprovals(lease, log, definition, context, modelEntry);
          for (const call of pendingCalls) {
            const approval = approvals.find((row) => row.toolCallId === call.toolCallId);
            if (approval?.status === 'pending') continue;
            await lease.renew();
            if (approval && approval.decidedAt !== null)
              await log.emit({
                type: 'tool-approval-response',
                approvalId: approval.id,
                approved: approval.status === 'approved',
                ...(approval.reason === null ? {} : { reason: approval.reason }),
              });
            let output: unknown;
            if (approval?.status === 'denied' || approval?.status === 'expired') {
              output = {
                type: 'execution-denied',
                ...(approval.reason === null ? {} : { reason: approval.reason }),
              };
              await log.emit({ type: 'tool-output-denied', toolCallId: call.toolCallId });
            } else {
              const result = await timed(lease, definition.timeouts?.toolMs, (signal) =>
                runTool(
                  { runtime: lease.runtime, idempotency: deps.idempotency },
                  definition,
                  { ...context, signal },
                  modelEntry.seq,
                  call,
                  messages(lease.row, entries),
                ),
              );
              output = result.error
                ? { type: 'error-text', value: result.output }
                : { type: 'json', value: result.output };
              await log.emit(
                result.error
                  ? {
                      type: 'tool-output-error',
                      toolCallId: call.toolCallId,
                      errorText: 'Agent tool failed.',
                    }
                  : {
                      type: 'tool-output-available',
                      toolCallId: call.toolCallId,
                      output: result.output,
                    },
              );
            }
            const entry: AgentRunEntryRow = {
              id: childId(lease.row.id, lease.row.entryCount),
              runId: lease.row.id,
              tenantId: lease.row.tenantId,
              seq: lease.row.entryCount,
              kind: 'tool',
              messages: [
                json({
                  role: 'tool',
                  content: [
                    {
                      type: 'tool-result',
                      toolCallId: call.toolCallId,
                      toolName: call.toolName,
                      output,
                    },
                  ],
                }),
              ],
              finishReason: null,
              usage: null,
              toolCallId: call.toolCallId,

              stepChunkStart: null,
            };
            // Store the call's chunks before committing its entry: once the
            // entry commits, no holder emits them again, so a crash in between
            // must find them already in the log. The reverse crash replays the
            // call's stored result and emits its output a second time.
            await log.flush();
            await lease.serial(async () => {
              lease.row = await lease.store.appendEntry(lease.row, entry);
            });
            entries.push(entry);
            await deps.hooks?.afterToolEntry?.(entry);
          }
          await log.flush();
          if (approvals.some((row) => row.status === 'pending')) {
            await lease.write({ status: 'waiting', leaseOwner: '', leaseUntil: 0 });
            // A decision may have raced the pending snapshot. Check after
            // publishing waiting, so either this holder continues or the
            // decider can acquire the released run.
            if (
              !(await lease.store.approvals(lease.row.id)).some((row) => row.status === 'pending')
            ) {
              await lease.write({ status: 'ready' });
            }
            return;
          }
        }
        if (
          modelEntry.finishReason !== 'tool-calls' ||
          modelEntries.length >= (definition.maxSteps ?? 20)
        ) {
          await log.emit({ type: 'finish' });
          await log.flush();
          await lease.write({ status: 'completed', leaseOwner: '', leaseUntil: 0 });
          return;
        }
      }
      await log.flush();
      await lease.write({ stepChunkStart: lease.row.chunkCount });
      await lease.renew();
      const result = await timed(lease, definition.timeouts?.modelMs, async (signal) => {
        const generation = deps.ai.model({
          model: definition.model({ ...context, signal }),
          messages: messages(lease.row, entries),
          tools: schemaOnly(definition.tools ?? {}),
          maxOutputTokens: definition.maxOutputTokens,
          abortSignal: signal,
          ...(definition.system === undefined ? {} : { system: definition.system }),
        });
        const reader = generation.chunks.getReader();
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            if (next.value.type === 'error') throw new Error('Agent model call failed.');
            if (next.value.type === 'abort') throw new Error('Agent model call aborted.');
            if (next.value.type !== 'tool-input-delta' && next.value.type !== 'tool-input-start')
              await log.emit(next.value);
          }
        } finally {
          reader.releaseLock();
        }
        return generation.result();
      });
      const entry: AgentRunEntryRow = {
        id: childId(lease.row.id, lease.row.entryCount),
        runId: lease.row.id,
        tenantId: lease.row.tenantId,
        seq: lease.row.entryCount,
        kind: 'model',
        messages: result.messages.map(json),
        finishReason: result.finishReason,
        usage: json(result.usage),
        toolCallId: null,

        stepChunkStart: lease.row.stepChunkStart,
      };
      // The step's chunks first, then its entry (see the tool entry above): a
      // crash before the entry commits retries the model call behind a
      // `reset-step`, which discards the stored partial step.
      await log.flush();
      await lease.serial(async () => {
        lease.row = await lease.store.appendEntry(lease.row, entry);
      });
      entries.push(entry);
      await deps.hooks?.afterModelEntry?.(entry);
    }
  } catch (error) {
    if (error instanceof AgentRunLeaseLostError || lease.lost || error instanceof ToolConflict)
      return;
    const cancelled = lease.controller.signal.aborted;
    if (!cancelled) {
      // Value-free: the error class and status hint, never its message, inputs
      // or ids (plan §8a O6); the SDK's own onError log is suppressed.
      const status = httpStatusHintOf(error)?.status;
      deps.logger?.warn('Agent run failed.', {
        definition: definition?.name ?? '',
        error: error instanceof Error ? error.name : typeof error,
        ...(status === undefined ? {} : { status }),
      });
    }
    await log.emit(
      cancelled ? { type: 'abort' } : { type: 'error', errorText: 'Agent run failed.' },
    );
    await log.flush();
    await lease.write({
      status: cancelled ? 'cancelled' : 'failed',
      error: cancelled ? null : 'execution-failed',
      leaseOwner: '',
      leaseUntil: 0,
    });
  } finally {
    lease.stop(true);
    log.closeTimer();
  }
}
