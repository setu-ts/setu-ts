import { CAPABILITIES } from '@setu-ts/common';
import type { IAgentRunService, IRouterApi, IServiceRegistry } from '@setu-ts/common';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { validateBody, validateHeaders, validateParams } from '@setu-ts/validation-plugin';
import { SUPPORT_AGENT } from './support.agent.ts';
import { orderSummary } from './support.orders.ts';
import type { Order, OrderSummary, Refund } from './support.orders.ts';
import {
  AcceptedResponse,
  ApprovalParams,
  DecisionBody,
  DemoUserHeaders,
  OrdersResponse,
  RunParams,
  RunViewResponse,
  StartRunBody,
  StartRunResponse,
} from './support.schemas.ts';

const demoUser = validateHeaders(DemoUserHeaders);
const startBody = validateBody(StartRunBody);
const decisionBody = validateBody(DecisionBody);
const runParams = validateParams(RunParams);
const approvalParams = validateParams(ApprovalParams);

/**
 * Registers the support routes. Every run route goes through the agent-runs
 * service, which scopes runs to the principal that started them: another
 * demo user gets the same 404 as a missing run.
 *
 * A run executes detached from the request that started it. `POST /runs`
 * answers `202` at once; the page reads progress from `GET /runs/:id/stream`,
 * which replays what is stored and then follows the live run, resuming after
 * `Last-Event-ID` on a reconnect.
 */
export function registerSupportRoutes(router: IRouterApi, services?: IServiceRegistry): void {
  if (services === undefined) throw new Error('support routes need the service registry');
  const runs = (): IAgentRunService => services.get<IAgentRunService>(CAPABILITIES.AGENT_RUNS);

  router.group('/runs', (routes) => {
    routes.post('/', {
      middleware: [demoUser, startBody],
      schema: { response: { 202: StartRunResponse } },
      handler: async (ctx) => {
        const { message, history } = startBody.value(ctx);
        const started = await runs().start(ctx, SUPPORT_AGENT, {
          messages: [...history, { role: 'user', content: message }],
        });
        return ctx.response.status(202).json(started);
      },
    });
    routes.get('/:id', {
      middleware: [demoUser, runParams],
      schema: { response: { 200: RunViewResponse } },
      handler: async (ctx) => {
        const view = await runs().get(ctx, runParams.value(ctx).id);
        return ctx.response.json({
          ...view,
          pendingApprovals: view.pendingApprovals.map((a) => ({
            id: a.id,
            toolCallId: a.toolCallId,
            toolName: a.toolName,
            input: a.input,
            deadline: a.deadline,
          })),
        });
      },
    });
    // The AI SDK's resume path (`GET <api>/<chatId>/stream`): 204 when a
    // finished run has nothing left to send.
    routes.get('/:id/stream', {
      middleware: [demoUser, runParams],
      handler: (ctx) => runs().respond(ctx, runParams.value(ctx).id),
    });
    routes.post('/:id/approvals/:approvalId', {
      middleware: [demoUser, approvalParams, decisionBody],
      schema: { response: { 202: AcceptedResponse } },
      handler: async (ctx) => {
        const { id, approvalId } = approvalParams.value(ctx);
        const { approved, reason } = decisionBody.value(ctx);
        await runs().decide(ctx, id, approvalId, {
          approved,
          ...(reason === undefined ? {} : { reason }),
        });
        return ctx.response.status(202).json({ accepted: true });
      },
    });
    routes.post('/:id/cancel', {
      middleware: [demoUser, runParams],
      schema: { response: { 202: AcceptedResponse } },
      handler: async (ctx) => {
        await runs().cancel(ctx, runParams.value(ctx).id);
        return ctx.response.status(202).json({ accepted: true });
      },
    });
  });

  router.get('/orders', {
    schema: { response: { 200: OrdersResponse } },
    handler: async (ctx) => {
      const database = services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const repos = {
        orders: database.getRepository<Order>('Order'),
        refunds: database.getRepository<Refund>('Refund'),
      };
      const orders: OrderSummary[] = [];
      for (const { id } of await repos.orders.findAll({ orderBy: { id: 'asc' } })) {
        const summary = await orderSummary(repos, id);
        if (summary) orders.push(summary);
      }
      return ctx.response.json({ orders });
    },
  });
}
