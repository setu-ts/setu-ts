/** Durable agent-run ports. No SDK or database dependency. @module */
import type { HandlerResult, IRequestContext } from '../http.ts';
import type { WritePrecondition } from './write-precondition.ts';

/** JSON persisted across processes. @since 0.12.0 */
export type AgentRunJson =
  | null
  | boolean
  | number
  | string
  | readonly AgentRunJson[]
  | { readonly [key: string]: AgentRunJson };
/** Durable run state. @since 0.12.0 */
export type AgentRunStatus = 'running' | 'waiting' | 'ready' | 'completed' | 'failed' | 'cancelled';
/** Run identity, lease and committed log counters. @since 0.12.0 */
export interface AgentRunRow {
  /** Stable persisted row identifier. */
  readonly id: string;
  /** Persisted tenant id; the empty string denotes a tenant-less run. */
  readonly tenantId: string;
  /** Original authenticated subject, or null when absent. */
  readonly principalId: string | null;
  /** Registered definition name. */
  readonly definition: string;
  /** Definition version stamped at creation. */
  readonly version: string;
  /** Persisted lifecycle state. */
  readonly status: AgentRunStatus;
  /** Original JSON model input. */
  readonly input: readonly AgentRunJson[];
  /** Current instance id, or the empty string when unheld. */
  readonly leaseOwner: string;
  /** Monotonically increasing fencing token. */
  readonly leaseVersion: number;
  /** Wall-clock lease deadline in milliseconds. */
  readonly leaseUntil: number;
  /** Exclusive committed entry sequence bound. */
  readonly entryCount: number;
  /** Approval child ids made visible by a fenced commit on this row. */
  readonly approvalIds: readonly string[];
  /** Exclusive committed chunk-batch sequence bound. */
  readonly chunkCount: number;
  /** Chunk-batch boundary of the model attempt. */
  readonly stepChunkStart: number;
  /** Whether cancellation has been requested. */
  readonly cancelRequested: boolean;
  /** Value-free terminal failure code, or null. */
  readonly error: string | null;
  /** Wall-clock creation time in milliseconds. */
  readonly createdAt: number;
  /** Wall-clock last transition time in milliseconds. */
  readonly updatedAt: number;
}
/** One committed model response or tool result. @since 0.12.0 */
export interface AgentRunEntryRow {
  /** Stable persisted row identifier. */
  readonly id: string;
  /** Parent run id. */
  readonly runId: string;
  /** Persisted tenant id; the empty string denotes a tenant-less run. */
  readonly tenantId: string;
  /** Ordered sequence within the run. */
  readonly seq: number;
  /** Whether this entry records a model response or tool result. */
  readonly kind: 'model' | 'tool';
  /** Persisted model messages in order. */
  readonly messages: readonly AgentRunJson[];
  /** SDK finish reason for a model entry, or null. */
  readonly finishReason: string | null;
  /** JSON SDK model usage, or null for tools. */
  readonly usage: AgentRunJson;
  /** SDK tool-call id. */
  readonly toolCallId: string | null;
  /** Model-call chunk boundary; null for tool entries. */
  readonly stepChunkStart: number | null;
}
/** A committed, ordered batch of SDK UI chunks. @since 0.12.0 */
export interface AgentRunChunkBatch {
  /** Stable persisted row identifier. */
  readonly id: string;
  /** Parent run id. */
  readonly runId: string;
  /** Persisted tenant id; the empty string denotes a tenant-less run. */
  readonly tenantId: string;
  /** Ordered sequence within the run. */
  readonly seq: number;
  /** Lease version of the holder that wrote the batch; part of each event id. */
  readonly leaseVersion: number;
  /** Ordered JSON UI-message chunks. */
  readonly chunks: readonly AgentRunJson[];
}
/** Server-owned, single-use approval decision. @since 0.12.0 */
export interface AgentRunApprovalRow {
  /** Stable persisted row identifier. */
  readonly id: string;
  /** Parent run id. */
  readonly runId: string;
  /** Persisted tenant id; the empty string denotes a tenant-less run. */
  readonly tenantId: string;
  /** Ordered sequence within the run. */
  readonly seq: number;
  /** SDK tool-call id. */
  readonly toolCallId: string;
  /** Application tool name. */
  readonly toolName: string;
  /** Original JSON model input. */
  readonly input: AgentRunJson;
  /** Persisted lifecycle state. */
  readonly status: 'pending' | 'approved' | 'denied' | 'expired';
  /** Wall-clock approval deadline in milliseconds. */
  readonly deadline: number;
  /** Deciding principal id, or null. */
  readonly decidedBy: string | null;
  /** Wall-clock decision time, or null. */
  readonly decidedAt: number | null;
  /** Decision or expiry reason, or null. */
  readonly reason: string | null;
}
/** Tenant-scoped page-reload representation. @since 0.12.0 */
export interface AgentRunView {
  /** Stable persisted row identifier. */
  readonly id: string;
  /** Persisted lifecycle state. */
  readonly status: AgentRunStatus;
  /** Registered definition name. */
  readonly definition: string;
  /** Definition version stamped at creation. */
  readonly version: string;
  /** Persisted model messages in order. */
  readonly messages: readonly AgentRunJson[];
  /** Committed approval rows still pending. */
  readonly pendingApprovals: readonly AgentRunApprovalRow[];
  /** Value-free terminal failure code, or null. */
  readonly error?: string;
}
/** Counts of conditional changes made by one bounded sweep. @since 0.12.0 */
export interface AgentRunSweepReport {
  /** Number of approvals expired in this sweep. */
  readonly expired: number;
  /** Number of leases acquired for recovery. */
  readonly resumed: number;
  /** Number of terminal runs purged. */
  readonly purged: number;
}
/** Persistence port; all holder mutations are fenced. @since 0.12.0 */
export interface IAgentRunStore {
  /** Probe conditional writes before registration succeeds. */
  verify(): Promise<void>;
  /** Insert a new run. */
  create(row: AgentRunRow): Promise<void>;
  /** Read by id. */
  get(id: string): Promise<AgentRunRow | null>;
  /** Compare-and-set; null means a lost race. */
  update(
    id: string,
    where: WritePrecondition,
    data: Partial<AgentRunRow>,
  ): Promise<AgentRunRow | null>;
  /** Append then conditionally advance entryCount; raises lease lost on conflict. */
  appendEntry(run: AgentRunRow, entry: AgentRunEntryRow): Promise<AgentRunRow>;
  /** Append then conditionally advance chunkCount; raises lease lost on conflict. */
  appendChunks(run: AgentRunRow, batch: AgentRunChunkBatch): Promise<AgentRunRow>;
  /** Read only entries below the committed counter. */
  entries(run: AgentRunRow): Promise<readonly AgentRunEntryRow[]>;
  /** Read only batches below the committed counter, starting at from. */
  chunks(run: AgentRunRow, from: number): Promise<readonly AgentRunChunkBatch[]>;
  /** Insert a pending approval while holding the run lease. */
  createApproval(run: AgentRunRow, approval: AgentRunApprovalRow): Promise<AgentRunRow>;
  /** Read approvals belonging to a run. */
  approvals(runId: string): Promise<readonly AgentRunApprovalRow[]>;
  /** Single decision; null means another decision won. */
  decide(id: string, data: Partial<AgentRunApprovalRow>): Promise<AgentRunApprovalRow | null>;
  /** Bounded query of overdue pending approvals. */
  expired(now: number, limit: number): Promise<readonly AgentRunApprovalRow[]>;
  /** Bounded query of ready or abandoned runs; now already includes skew. */
  resumable(now: number, limit: number): Promise<readonly AgentRunRow[]>;
  /** Bounded query of old terminal runs. */
  terminal(before: number, limit: number): Promise<readonly AgentRunRow[]>;
  /** Delete a terminal run's children, then the run itself conditionally. */
  purge(run: AgentRunRow, limit?: number): Promise<boolean>;
}
/** Durable run API registered under CAPABILITIES.AGENT_RUNS. @since 0.12.0 */
export interface IAgentRunService {
  /** Create and detach execution using server-owned identity. */
  start(
    ctx: IRequestContext,
    definition: string,
    input: { messages: readonly AgentRunJson[] },
  ): Promise<{ runId: string }>;
  /** Replay and tail the SDK UI stream. */
  respond(ctx: IRequestContext, runId: string): Promise<HandlerResult>;
  /** Authorize and atomically decide one pending approval. */
  decide(
    ctx: IRequestContext,
    runId: string,
    approvalId: string,
    decision: { approved: boolean; reason?: string },
  ): Promise<void>;
  /** Request cancellation, aborting a local holder immediately. */
  cancel(ctx: IRequestContext, runId: string): Promise<void>;
  /** Read status, messages and pending approvals. */
  get(ctx: IRequestContext, runId: string): Promise<AgentRunView>;
  /** Expire approvals, recover abandoned runs and purge retention. */
  sweep(): Promise<AgentRunSweepReport>;
}
