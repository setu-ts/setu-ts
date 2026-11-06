import { AgentRunLeaseLostError } from '@setu-ts/common';
import type { AgentRunRow, AgentRunSweepReport, IAgentRunStore } from '@setu-ts/common';
import { changeRun } from '../approvals/approvals.ts';

/** One bounded sweep; all mutations are CAS and losing a race is harmless. @internal */
export async function sweep(
  store: IAgentRunStore,
  options: { now: number; maxClockSkewMs: number; sweepBatch: number; retentionMs: number },
  resume: (run: AgentRunRow) => Promise<boolean>,
): Promise<AgentRunSweepReport> {
  let expired = 0;
  let resumed = 0;
  let purged = 0;
  for (const approval of await store.expired(options.now, options.sweepBatch)) {
    const won = await store.decide(approval.id, {
      status: 'expired',
      decidedAt: options.now,
      reason: 'timed out',
    });
    if (!won) continue;
    expired++;
    const run = await store.get(approval.runId);
    if (
      run?.status === 'waiting' &&
      run.leaseOwner === '' &&
      !(await store.approvals(run.id)).some((row) => row.status === 'pending')
    ) {
      try {
        await changeRun(store, run, { status: 'ready', updatedAt: options.now });
      } catch (error) {
        if (!(error instanceof AgentRunLeaseLostError)) throw error;
      }
    }
  }
  for (const run of await store.resumable(options.now - options.maxClockSkewMs, options.sweepBatch))
    if (await resume(run)) resumed++;
  for (const run of await store.terminal(options.now - options.retentionMs, options.sweepBatch))
    if (await store.purge(run, options.sweepBatch)) purged++;
  return { expired, resumed, purged };
}
