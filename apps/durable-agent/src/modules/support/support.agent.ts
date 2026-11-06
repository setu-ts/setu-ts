import { tool } from 'ai';
import { z } from 'zod';
import { CAPABILITIES } from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';
import { defineAgentRun } from '@setu-ts/agent-runs-plugin';
import type { AgentRunDefinition } from '@setu-ts/agent-runs-plugin';
import type { IUnitOfWork } from '@setu-ts/database-plugin';
import { SUPPORT_MODEL } from '../../plugins/support-model.plugin.ts';
import type { ISupportModelService } from '../../plugins/support-model.plugin.ts';
import { orderSummary } from './support.orders.ts';
import type { Order, OrderRepositories, Refund } from './support.orders.ts';

/** The definition name runs are started with and stored under. */
export const SUPPORT_AGENT = 'support';

/** The largest number of model calls one run may make. */
export const MAX_STEPS = 8;

/** The output-token limit every model call is made with. */
export const MAX_OUTPUT_TOKENS = 1024;

// Server-owned context, never model-settable input: the transaction the tool's
// writes commit in, the call's idempotency key and the run it belongs to.
const toolContext = z.object({
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
  description: 'Look up an order by id, with the amount already refunded. Amounts are in cents.',
  inputSchema: z.object({ orderId: z.string().min(1).max(32) }),
  contextSchema: toolContext,
  execute: async ({ orderId }, { context }) =>
    (await orderSummary(repositories(context), orderId)) ?? { error: 'No such order.' },
});

/**
 * Refunds part or all of an order. Always needs a person's approval first, and
 * writes its row through the run's unit of work: the refund commits with the
 * tool's idempotency record, so a resumed run never refunds twice.
 */
export const issueRefund = tool({
  description:
    'Refund an order. Needs a person to approve it. amountCents must not exceed what is left to refund.',
  inputSchema: z.object({
    orderId: z.string().min(1).max(32),
    amountCents: z.number().int().positive(),
    reason: z.string().min(1).max(200),
  }),
  contextSchema: toolContext,
  execute: async ({ orderId, amountCents, reason }, { context }) => {
    const repos = repositories(context);
    const order = await orderSummary(repos, orderId);
    if (!order) return { error: 'No such order.' };
    if (amountCents > order.amountCents - order.refundedCents)
      return { error: 'That is more than is left to refund on this order.' };
    const refund: Refund = {
      id: context.idempotencyKey,
      orderId,
      amountCents,
      reason,
      runId: context.runId,
      createdAt: context.now,
    };
    await repos.refunds.create(refund);
    return { refundId: refund.id, orderId, amountCents };
  },
});

/** The support agent: look an order up, then refund it once a person approves. */
export function supportAgent(): AgentRunDefinition {
  return defineAgentRun({
    name: SUPPORT_AGENT,
    version: '1',
    // Resolved per model call, so a resumed run uses whichever model the
    // serving process has, and tests can replace the capability.
    model: (run) => run.services.get<ISupportModelService>(SUPPORT_MODEL).model,
    system:
      'You are a support agent for an online shop. Look an order up before refunding it. ' +
      'Refund only what the customer asks for, and never more than is left on the order. ' +
      'Amounts are in cents; show them to the customer in dollars. Be brief.',
    tools: { lookupOrder, issueRefund },
    toolsContext: (run, call) => {
      const context: ToolContext = {
        unitOfWork: call.unitOfWork as IUnitOfWork,
        idempotencyKey: call.idempotencyKey,
        runId: run.runId,
        // Time comes from the runtime services, like every other clock read.
        now: run.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME).now(),
      };
      return { lookupOrder: context, issueRefund: context };
    },
    approval: { tools: { issueRefund: true } },
    maxSteps: MAX_STEPS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
}
