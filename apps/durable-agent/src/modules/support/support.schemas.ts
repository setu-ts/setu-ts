import { z } from 'zod';

/** The demonstration identity header; see `src/middleware/demo-user.middleware.ts`. */
export const DemoUserHeaders = z.object({
  'x-demo-user': z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/)
    .optional()
    .describe('Demonstration identity (lowercase letters, digits, dashes). Defaults to "demo".'),
});

/** A customer message that starts a run. */
export const StartRunBody = z.object({ message: z.string().trim().min(1).max(2000) });
export type StartRunBody = z.infer<typeof StartRunBody>;

/** The started run. */
export const StartRunResponse = z.object({ runId: z.string() });

/** A run id in the path. */
export const RunParams = z.object({ id: z.string().min(1).max(64) });

/** A run id and one of its approvals in the path. */
export const ApprovalParams = RunParams.extend({ approvalId: z.string().min(1).max(256) });

/** A person's decision on a refund the agent asked to issue. */
export const DecisionBody = z.object({
  approved: z.boolean(),
  reason: z.string().trim().min(1).max(200).optional(),
});
export type DecisionBody = z.infer<typeof DecisionBody>;

/** Accepted; read the outcome from the run's stream or `GET /runs/:id`. */
export const AcceptedResponse = z.object({ accepted: z.literal(true) });

const json: z.ZodType<unknown> = z.unknown();

/** `GET /runs/:id`: status, rebuilt messages and pending approvals, for a page reload. */
export const RunViewResponse = z.object({
  id: z.string(),
  status: z.enum(['running', 'waiting', 'ready', 'completed', 'failed', 'cancelled']),
  definition: z.string(),
  version: z.string(),
  messages: z.array(json),
  pendingApprovals: z.array(
    z.object({
      id: z.string(),
      toolCallId: z.string(),
      toolName: z.string(),
      input: json,
      deadline: z.number(),
    }),
  ),
  error: z.string().optional(),
});

/** One order, with what has been refunded on it. */
export const OrderResponse = z.object({
  id: z.string(),
  customer: z.string(),
  item: z.string(),
  amountCents: z.number().int(),
  refundedCents: z.number().int(),
});

/** `GET /orders`. */
export const OrdersResponse = z.object({ orders: z.array(OrderResponse) });
