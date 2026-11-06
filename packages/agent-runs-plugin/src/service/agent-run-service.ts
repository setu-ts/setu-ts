import {
  AgentRunDefinitionError,
  AgentRunNotFoundError,
  AgentRunStateError,
} from '@setu-ts/common';
import type {
  AgentRunRow,
  AgentRunJson,
  AgentRunView,
  AgentRunSweepReport,
  HandlerResult,
  IAgentRunStore,
  IAgentRunService,
  IIdempotencyService,
  IRequestContext,
  IRuntimeServices,
  IServiceRegistry,
} from '@setu-ts/common';
import type { AgentRunContext, AgentRunDefinition } from '../definitions/define-agent-run.ts';
import type { ResolvedOptions } from '../plugin/agent-runs-plugin.ts';
import type { AiRuntime } from '../runtime/ai-runtime.ts';
import type { LoopHooks } from '../loop/step-loop.ts';
import { stepLoop } from '../loop/step-loop.ts';
import { claim, Lease } from '../lease/lease.ts';
import { ChunkLog } from '../log/chunk-log.ts';
import { respond, terminal } from '../log/respond.ts';
import { messages, json, inputMessages } from '../loop/messages.ts';
import { changeRun, decideApproval } from '../approvals/approvals.ts';
import { sweep } from '../sweep/sweep.ts';

/** Internal dependencies; hooks exist solely for deterministic crash tests. @internal */
export interface ServiceDeps {
  readonly store: IAgentRunStore;
  readonly runtime: IRuntimeServices;
  readonly services: IServiceRegistry;
  readonly idempotency: IIdempotencyService;
  readonly ai: AiRuntime;
  readonly definitions: ReadonlyMap<string, AgentRunDefinition>;
  readonly options: ResolvedOptions;
  readonly background?: (ctx: IRequestContext, work: Promise<void>) => void;
  readonly hooks?: LoopHooks;
}
/** Durable run coordinator; only public through IAgentRunService. @internal */
export class AgentRunService implements IAgentRunService {
  readonly deps: ServiceDeps;
  readonly active: Map<string, ChunkLog> = new Map();
  readonly work: Set<Promise<void>> = new Set();
  readonly #running = new Map<string, Promise<void>>();
  readonly owner: string;
  #closed = false;
  constructor(deps: ServiceDeps) {
    this.deps = deps;
    this.owner = deps.runtime.uuid();
  }
  async #row(ctx: IRequestContext, id: string): Promise<AgentRunRow> {
    const run = await this.deps.store.get(id);
    if (!run || run.tenantId !== (ctx.request.tenant?.id ?? '')) throw new AgentRunNotFoundError();
    return run;
  }
  #context(run: AgentRunRow): AgentRunContext {
    return {
      runId: run.id,
      tenantId: run.tenantId,
      principalId: run.principalId,
      services: this.deps.services,
      signal: new AbortController().signal,
    };
  }
  async resume(run: AgentRunRow, ctx?: IRequestContext): Promise<boolean> {
    if (this.#closed || this.active.has(run.id)) return false;
    if (run.status === 'waiting') {
      if (
        run.leaseOwner !== '' &&
        this.deps.runtime.now() <= run.leaseUntil + this.deps.options.maxClockSkewMs
      )
        return false;
      if (
        !run.cancelRequested &&
        (await this.deps.store.approvals(run.id)).some((row) => row.status === 'pending')
      )
        return false;
      const ready = await this.deps.store.update(
        run.id,
        { status: 'waiting', leaseVersion: run.leaseVersion, leaseUntil: run.leaseUntil },
        { status: 'ready' },
      );
      if (!ready) return false;
      run = ready;
    }
    const lease = await claim(
      this.deps.store,
      this.deps.runtime,
      run,
      this.owner,
      this.deps.options.leaseMs,
      this.deps.options.maxClockSkewMs,
    );
    if (!lease) return false;
    const log = new ChunkLog(lease, this.deps.options);
    this.active.set(run.id, log);
    const work = stepLoop(lease, log, this.deps.definitions.get(run.definition), this.deps)
      .finally(() => {
        if (this.active.get(run.id) === log) this.active.delete(run.id);
        this.#running.delete(run.id);
        this.work.delete(work);
      })
      .then(async () => {
        if (this.#closed) return;
        const current = await this.deps.store.get(run.id);
        if (current?.status === 'ready') await this.resume(current, ctx);
      })
      .catch(() => {
        // Leave a failed store operation for the sweep; no unfenced repair.
        lease.stop(true);
      });
    this.work.add(work);
    this.#running.set(run.id, work);
    if (ctx) this.deps.background?.(ctx, work);
    return true;
  }
  async start(
    ctx: IRequestContext,
    name: string,
    input: { messages: readonly AgentRunJson[] },
  ): Promise<{ runId: string }> {
    const definition = this.deps.definitions.get(name);
    if (!definition || this.#closed) throw new AgentRunDefinitionError();
    if (!input || !Array.isArray(input.messages)) throw new AgentRunStateError();
    const encoded = JSON.stringify(input.messages);
    if (new TextEncoder().encode(encoded).length > this.deps.options.maxInputBytes)
      throw new AgentRunStateError(413);
    const now = this.deps.runtime.now();
    const run: AgentRunRow = {
      id: this.deps.runtime.uuid(),
      tenantId: ctx.request.tenant?.id ?? '',
      principalId: ctx.request.user?.id ?? null,
      definition: definition.name,
      version: definition.version,
      status: 'running',
      input: inputMessages(input.messages),
      leaseOwner: '',
      leaseVersion: 0,
      leaseUntil: 0,
      entryCount: 0,
      approvalIds: [],
      chunkCount: 0,
      stepChunkStart: 0,
      cancelRequested: false,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.store.create(run);
    await this.resume(run, ctx);
    return { runId: run.id };
  }
  async respond(ctx: IRequestContext, runId: string): Promise<HandlerResult> {
    const row = await this.#row(ctx, runId);
    const local = this.active.get(runId);
    return respond(ctx, row, {
      store: this.deps.store,
      runtime: this.deps.runtime,
      headers: this.deps.ai.headers,
      pollIntervalMs: this.deps.options.pollIntervalMs,
      ...(local ? { local } : {}),
    });
  }
  async get(ctx: IRequestContext, runId: string): Promise<AgentRunView> {
    const row = await this.#row(ctx, runId);
    return {
      id: row.id,
      status: row.status,
      definition: row.definition,
      version: row.version,
      messages: json(messages(row, await this.deps.store.entries(row))) as readonly AgentRunJson[],
      pendingApprovals: (await this.deps.store.approvals(runId)).filter(
        (a) => a.status === 'pending',
      ),
      ...(row.error === null ? {} : { error: row.error }),
    };
  }
  async decide(
    ctx: IRequestContext,
    runId: string,
    approvalId: string,
    decision: { approved: boolean; reason?: string },
  ): Promise<void> {
    let row = await this.#row(ctx, runId);
    if (terminal(row)) throw new AgentRunStateError();
    const definition = this.deps.definitions.get(row.definition);
    if (!definition) throw new AgentRunDefinitionError();
    const approval = await decideApproval(
      this.deps.store,
      row,
      definition,
      this.#context(row),
      ctx,
      approvalId,
      decision,
      this.deps.runtime.now(),
    );
    const local = this.active.get(runId);
    if (local)
      await local.emit({
        type: 'tool-approval-response',
        approvalId,
        approved: approval.status === 'approved',
        ...(approval.reason === null ? {} : { reason: approval.reason }),
      });
    row = await this.#row(ctx, runId);
    // A parked run has no runner. Briefly acquire its lease to persist the
    // decision chunk before releasing it; a concurrent decider's winner also
    // checks all pending rows before waking execution.
    if (!local && row.status === 'waiting' && row.leaseOwner === '') {
      const held = await this.deps.store.update(
        row.id,
        { status: 'waiting', leaseVersion: row.leaseVersion, leaseOwner: '' },
        {
          leaseVersion: row.leaseVersion + 1,
          leaseOwner: this.owner,
          leaseUntil: this.deps.runtime.now() + this.deps.options.leaseMs,
        },
      );
      if (held) {
        const lease = new Lease(
          held,
          this.deps.store,
          this.deps.runtime,
          this.deps.options.leaseMs,
        );
        const log = new ChunkLog(lease, this.deps.options);
        try {
          await log.restore();
          await log.emit({
            type: 'tool-approval-response',
            approvalId,
            approved: approval.status === 'approved',
            ...(approval.reason === null ? {} : { reason: approval.reason }),
          });
          await log.flush();
          await lease.write({ leaseOwner: '', leaseUntil: 0 });
          row = lease.row;
        } finally {
          lease.stop();
          log.closeTimer();
        }
      }
    }
    if (
      row.status === 'waiting' &&
      row.leaseOwner === '' &&
      !(await this.deps.store.approvals(runId)).some((a) => a.status === 'pending')
    ) {
      row = await changeRun(this.deps.store, row, {
        status: 'ready',
        updatedAt: this.deps.runtime.now(),
      });
      await this.resume(row, ctx);
    }
  }
  async cancel(ctx: IRequestContext, runId: string): Promise<void> {
    const row = await this.#row(ctx, runId);
    if (terminal(row)) throw new AgentRunStateError();
    const local = this.active.get(runId);
    await changeRun(this.deps.store, row, {
      cancelRequested: true,
      updatedAt: this.deps.runtime.now(),
    });
    if (local) local.lease.controller.abort();
    else if (row.status === 'waiting' || row.status === 'ready') {
      const ready = await this.#row(ctx, runId);
      const updated = await changeRun(this.deps.store, ready, { status: 'ready' });
      await this.resume(updated, ctx);
    }
  }
  async sweep(): Promise<AgentRunSweepReport> {
    return await sweep(
      this.deps.store,
      { ...this.deps.options, now: this.deps.runtime.now() },
      async (row) => {
        const resumed = await this.resume(row);
        // A cron invocation must remain alive for the work it recovered.
        while (this.#running.has(row.id)) await this.#running.get(row.id);
        return resumed;
      },
    );
  }
  close(): void {
    this.#closed = true;
    for (const log of this.active.values()) {
      log.lease.stop(true);
      log.closeTimer();
    }
  }
}
