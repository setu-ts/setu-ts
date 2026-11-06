import {
  AgentRunDefinitionError,
  AgentRunLeaseLostError,
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
  ILogger,
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
import { changeRun, decideApproval, live, parked } from '../approvals/approvals.ts';
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
  readonly logger?: ILogger;
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
  #sweeping = false;
  constructor(deps: ServiceDeps) {
    this.deps = deps;
    this.owner = deps.runtime.uuid();
  }
  /**
   * Read a run the request may see: same tenant, and allowed by the
   * definition's `canAccess` (default: the starting principal, or anyone in
   * the tenant for a run started without one). Every refusal is the same 404.
   */
  async #row(ctx: IRequestContext, id: string, access = true): Promise<AgentRunRow> {
    const run = await this.deps.store.get(id);
    if (!run || run.tenantId !== (ctx.request.tenant?.id ?? '')) throw new AgentRunNotFoundError();
    if (access) {
      const canAccess = this.deps.definitions.get(run.definition)?.canAccess;
      const allowed = canAccess
        ? canAccess(ctx.request.user, this.#context(run))
        : run.principalId === null || ctx.request.user?.id === run.principalId;
      if (!allowed) throw new AgentRunNotFoundError();
    }
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
    // canDecide, not canAccess, governs a decision.
    const row = await this.#row(ctx, runId, false);
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
    // The decision is committed. Persisting its chunk and waking the run are
    // best effort from here: a lost race means another instance (or the
    // sweep's waiting scan) carries the run on, so the caller still succeeds.
    try {
      await this.#afterDecision(ctx, runId, approvalId, approval);
    } catch (error) {
      if (!(error instanceof AgentRunLeaseLostError)) throw error;
    }
  }
  async #afterDecision(
    ctx: IRequestContext,
    runId: string,
    approvalId: string,
    approval: { status: string; reason: string | null },
  ): Promise<void> {
    const chunk = {
      type: 'tool-approval-response' as const,
      approvalId,
      approved: approval.status === 'approved',
      ...(approval.reason === null ? {} : { reason: approval.reason }),
    };
    const local = this.active.get(runId);
    if (local) await local.emit(chunk);
    let row = await this.#row(ctx, runId, false);
    // A parked run has no runner. Briefly acquire its lease to persist the
    // decision chunk before releasing it; a concurrent decider's winner also
    // checks all pending rows before waking execution.
    if (!local && parked(row)) {
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
          await log.emit(chunk);
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
      parked(row) &&
      !(await this.deps.store.approvals(runId)).some((a) => a.status === 'pending')
    ) {
      const ready = await changeRun(
        this.deps.store,
        row,
        { status: 'ready', updatedAt: this.deps.runtime.now() },
        parked,
      );
      if (ready) await this.resume(ready, ctx);
    }
  }
  async cancel(ctx: IRequestContext, runId: string): Promise<void> {
    const row = await this.#row(ctx, runId);
    if (terminal(row)) throw new AgentRunStateError();
    const local = this.active.get(runId);
    const flagged = await changeRun(
      this.deps.store,
      row,
      { cancelRequested: true, updatedAt: this.deps.runtime.now() },
      live,
    );
    if (!flagged) return;
    if (local) {
      local.lease.controller.abort();
      return;
    }
    // A holder observes the flag at its next renewal. Only a parked run is
    // woken here, so a run another instance holds is never claimed twice.
    const ready = parked(flagged)
      ? await changeRun(this.deps.store, flagged, { status: 'ready' }, parked)
      : flagged;
    if (ready?.status === 'ready') await this.resume(ready, ctx);
  }
  async sweep(): Promise<AgentRunSweepReport> {
    if (this.#sweeping) return { expired: 0, resumed: 0, purged: 0 };
    this.#sweeping = true;
    const recovered: Promise<void>[] = [];
    try {
      const report = await sweep(
        this.deps.store,
        { ...this.deps.options, now: this.deps.runtime.now() },
        async (row) => {
          const resumed = await this.resume(row);
          const work = this.#running.get(row.id);
          if (resumed && work) recovered.push(work);
          return resumed;
        },
      );
      // A cron invocation must stay alive for the work it recovered; the
      // whole batch and the purge are claimed before waiting on any of it.
      await Promise.allSettled(recovered);
      return report;
    } finally {
      this.#sweeping = false;
    }
  }
  close(): void {
    this.#closed = true;
    for (const log of this.active.values()) {
      log.lease.stop(true);
      log.closeTimer();
    }
  }
}
