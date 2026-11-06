import { tool } from 'ai';
import { z } from 'zod';
import { CAPABILITIES } from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';
import { defineAgentRun } from '@setu-ts/agent-runs-plugin';
import type { AgentRunDefinition } from '@setu-ts/agent-runs-plugin';
import type { IUnitOfWork } from '@setu-ts/database-plugin';
import { SUPPORT_MODEL } from '../../plugins/support-model.plugin.ts';
import type { ISupportModelService } from '../../plugins/support-model.plugin.ts';
import { APPROVERS, ownOrder, refundOrder, summarize } from './support.orders.ts';
import type { Order, OrderRepositories, Refund } from './support.orders.ts';

/** The definition name runs are started with and stored under. */
export const SUPPORT_AGENT = 'support';

/** The largest number of model calls one run may make. */
export const MAX_STEPS = 8;

/** The output-token limit every model call is made with. */
export const MAX_OUTPUT_TOKENS = 1024;

// Server-owned context, never model-settable input: the transaction the tool's
// writes commit in, the call's idempotency key, the run it belongs to and the
// customer who started it. The tools act only on that customer's orders.
const toolContext = z.object({
  ownerId: z.string().nullable(),
  unitOfWork: z.custom<IUnitOfWork>(
    (value) => typeof value === 'object' && value !== null && 'getRepository' in value,
  ),
  idempotencyKey: z.string(),
  runId: z.string(),
  now: z.number(),
});
type ToolContext = z.infer<typeof toolContext>;

function repositories(context: ToolContext): OrderRepositories {
  return {
    orders: context.unitOfWork.getRepository<Order>('Order'),
    refunds: context.unitOfWork.getRepository<Refund>('Refund'),
  };
}

/** Reads an order and what has already been refunded. Runs without approval. */
export const lookupOrder = tool({
  description:
    'Look up an order by id, with the amount already refunded and what is left to refund. Amounts are in cents.',
  inputSchema: z.object({ orderId: z.string().min(1).max(32) }),
  contextSchema: toolContext,
  execute: async ({ orderId }, { context }) => {
    const repos = repositories(context);
    const order = await ownOrder(repos, context.ownerId, orderId);
    return order
      ? (await summarize(repos, order)).summary
      : { error: 'No such order on your account.' };
  },
});

/**
 * Refunds part or all of an order. Always needs a person's approval first, and
 * writes its row through the run's unit of work: the refund commits with the
 * tool's idempotency record, so a resumed run never refunds twice.
 */
export const issueRefund = tool({
  description:
    'Refund an order. A support lead must approve it. amountCents must not exceed what is left to refund.',
  inputSchema: z.object({
    orderId: z.string().min(1).max(32),
    amountCents: z.number().int().positive(),
    reason: z.string().min(1).max(200),
  }),
  contextSchema: toolContext,
  execute: async ({ orderId, amountCents, reason }, { context }) => {
    const result = await refundOrder(repositories(context), context.ownerId, {
      orderId,
      amountCents,
      reason,
      runId: context.runId,
      callKey: context.idempotencyKey,
      createdAt: context.now,
    });
    if (result === 'no-such-order') return { error: 'No such order on your account.' };
    if (result === 'too-much')
      return { error: 'That is more than is left to refund on this order.' };
    // The order's new totals, so the model reports them instead of working
    // them out (a model's arithmetic is not to be trusted with money).
    return { refundCents: amountCents, ...result };
  },
});

/** The support agent: look a customer's order up, then refund it once a support lead approves. */
export function supportAgent(): AgentRunDefinition {
  return defineAgentRun({
    name: SUPPORT_AGENT,
    version: '1',
    // Resolved per model call, so a resumed run uses whichever model the
    // serving process has, and tests can replace the capability.
    model: (run) => run.services.get<ISupportModelService>(SUPPORT_MODEL).model,
    system:
      'You are a support agent for an online shop, talking to a signed-in customer. ' +
      'You can only see and refund orders on their account. Look an order up before refunding it. ' +
      'Refund only what the customer asks for, and never more than is left on the order. ' +
      'Amounts are in cents; show them to the customer in dollars. Be brief. ' +
      'Answer in plain text: no Markdown, no asterisks or headings.',
    tools: { lookupOrder, issueRefund },
    toolsContext: (run, call) => {
      const context: ToolContext = {
        unitOfWork: call.unitOfWork as IUnitOfWork,
        idempotencyKey: call.idempotencyKey,
        runId: run.runId,
        ownerId: run.principalId,
        // Time comes from the runtime services, like every other clock read.
        now: run.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME).now(),
      };
      return { lookupOrder: context, issueRefund: context };
    },
    // A customer asks; a support lead decides. The default would let the
    // customer who started the run approve their own refund.
    approval: {
      tools: { issueRefund: true },
      canDecide: (principal) => principal !== undefined && APPROVERS.includes(principal.id),
    },
    // The customer who started the run, and the leads who must review it.
    canAccess: (principal, run) =>
      principal !== undefined &&
      (principal.id === run.principalId || APPROVERS.includes(principal.id)),
    maxSteps: MAX_STEPS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    // A provider that stops answering would otherwise hold the run (renewing
    // its lease) until someone cancels it; a timed-out model call fails the
    // run. Tool timeouts now recover through the sweep, but a timed-out
    // transaction still open when the run fails can commit afterwards. These short database writes
    // therefore keep no `toolMs` and only bound the model call.
    timeouts: { modelMs: 120_000 },
  });
}
