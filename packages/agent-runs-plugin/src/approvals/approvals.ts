import { AgentRunApprovalError, AgentRunLeaseLostError } from '@setu-ts/common';
import type {
  AgentRunApprovalRow,
  AgentRunEntryRow,
  AgentRunRow,
  IAgentRunStore,
  IRequestContext,
} from '@setu-ts/common';
import type { AgentRunContext, AgentRunDefinition } from '../definitions/define-agent-run.ts';
import type { Lease } from '../lease/lease.ts';
import type { ChunkLog } from '../log/chunk-log.ts';
import { calls } from '../loop/messages.ts';

/** Persist policy outcomes before executing any call from this entry. @internal */
export async function prepareApprovals(
  lease: Lease,
  log: ChunkLog,
  definition: AgentRunDefinition,
  context: AgentRunContext,
  entry: AgentRunEntryRow,
): Promise<readonly AgentRunApprovalRow[]> {
  let rows = await lease.store.approvals(lease.row.id);
  for (const call of calls(entry)) {
    if (rows.some((row) => row.toolCallId === call.toolCallId && row.seq === entry.seq)) continue;
    const policy = definition.approval?.tools[call.toolName];
    const needsApproval =
      policy === true || (typeof policy === 'function' && (await policy(call.input, context)));
    const row: AgentRunApprovalRow = {
      id: `${entry.id}.${encodeURIComponent(call.toolCallId)}`,
      runId: lease.row.id,
      tenantId: lease.row.tenantId,
      seq: entry.seq,
      ...call,
      status: needsApproval ? 'pending' : 'approved',
      deadline: lease.runtime.now() + (definition.approval?.timeoutMs ?? 86_400_000),
      decidedBy: null,
      decidedAt: null,
      reason: null,
    };
    await lease.serial(async () => {
      lease.row = await lease.store.createApproval(lease.row, row);
    });
    rows = [...rows, row];
    if (needsApproval)
      await log.emit({
        type: 'tool-approval-request',
        approvalId: row.id,
        toolCallId: call.toolCallId,
      });
  }
  return rows.filter((row) => row.seq === entry.seq);
}
/** Authorize using server identity, then single-use CAS. @internal */
export async function decideApproval(
  store: IAgentRunStore,
  run: AgentRunRow,
  definition: AgentRunDefinition,
  context: AgentRunContext,
  ctx: IRequestContext,
  id: string,
  decision: { approved: boolean; reason?: string },
  now: number,
): Promise<AgentRunApprovalRow> {
  const allowed = definition.approval?.canDecide
    ? definition.approval.canDecide(ctx.request.user, context)
    : run.principalId !== null && ctx.request.user?.id === run.principalId;
  if (!allowed) throw new AgentRunApprovalError(403);
  const row = (await store.approvals(run.id)).find((row) => row.id === id);
  if (
    !row ||
    row.status !== 'pending' ||
    row.deadline < now ||
    typeof decision.approved !== 'boolean'
  )
    throw new AgentRunApprovalError();
  const decided = await store.decide(id, {
    status: decision.approved ? 'approved' : 'denied',
    decidedBy: ctx.request.user?.id ?? null,
    decidedAt: now,
    reason: decision.reason ?? null,
  });
  if (!decided) throw new AgentRunApprovalError();
  return decided;
}
/**
 * Apply an unheld status/flag write by compare-and-set, re-reading after a lost
 * race. The write is re-applied only while `expect` still holds for the fresh
 * row, so a wake never lands on a run another instance has claimed since.
 * @returns The updated row, or null when the run no longer matches `expect`
 * @internal
 */
export async function changeRun(
  store: IAgentRunStore,
  run: AgentRunRow,
  data: Partial<AgentRunRow>,
  expect: (row: AgentRunRow) => boolean,
): Promise<AgentRunRow | null> {
  let current = run;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!expect(current)) return null;
    const updated = await store.update(
      current.id,
      { status: current.status, leaseVersion: current.leaseVersion },
      data,
    );
    if (updated) return updated;
    const fresh = await store.get(current.id);
    if (!fresh) return null;
    current = fresh;
  }
  throw new AgentRunLeaseLostError();
}
/** A parked run that nobody holds; the only state a decision or expiry may wake. @internal */
export function parked(row: AgentRunRow): boolean {
  return row.status === 'waiting' && row.leaseOwner === '';
}
/** A run that has not reached a terminal state. @internal */
export function live(row: AgentRunRow): boolean {
  return row.status !== 'completed' && row.status !== 'failed' && row.status !== 'cancelled';
}
