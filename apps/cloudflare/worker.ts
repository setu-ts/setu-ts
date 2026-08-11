import {
  createMessagingHandler,
  createScheduledHandler,
  ReplyInboxObjectCore,
  WorkersCron,
} from '@setu-ts/cloudflare-plugin';
import type {
  CloudflareWorkerEnv,
  IDurableObjectState,
  IDurableObjectWebSocket,
  IQueueMessageBatch,
  IScheduledController,
} from '@setu-ts/cloudflare-plugin';
import { createCloudflareApp } from './src/app.ts';
import type { IKernelApplication } from '@setu-ts/kernel';

interface WorkerEnvironment extends CloudflareWorkerEnv {
  readonly EXAMPLE_KV: {
    put(key: string, value: string): Promise<void>;
  };
}

let scheduledRuns = 0;
const cron = new WorkersCron().on('*/5 * * * *', () => {
  scheduledRuns += 1;
  return Promise.resolve();
});

export interface WorkerHandler {
  fetch(request: Request, env: WorkerEnvironment): Promise<Response>;
  /**
   * The booted application, shared with the `queue` export.
   *
   * Exposed because Cloudflare invokes a queue consumer as a separate
   * module-level export, and it must dispatch into the SAME application the
   * `fetch` path booted: a second one would carry its own broker with its own
   * dispatch table, and the subscriptions registered on one would be invisible
   * to the other.
   */
  application(env: WorkerEnvironment): Promise<IKernelApplication>;
}

export function createWorkerHandler(
  createApp: (env: WorkerEnvironment) => IKernelApplication = createCloudflareApp,
): WorkerHandler {
  let application: Promise<IKernelApplication> | undefined;
  const app = (env: WorkerEnvironment): Promise<IKernelApplication> => {
    if (application === undefined) {
      // Rejection is deliberately cached for the lifetime of this isolate. All
      // concurrent and later callers observe the same startup failure, and no
      // request reaches fetch on a partially initialized application.
      application = (async () => {
        const created = createApp(env);
        await created.start();
        return created;
      })();
    }
    return application;
  };

  return {
    fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
      return app(env).then((created) => created.fetch(request));
    },
    application: app,
  };
}

const workerHandler = createWorkerHandler();

/**
 * The Durable Object serving RPC reply inboxes.
 *
 * Deliberately NOT `extends DurableObject`: that base class lives in
 * `cloudflare:workers`, which Deno cannot resolve, so importing it would break
 * `deno check` on this example. workerd accepts a plain class taking
 * `(ctx, env)` — established against real workerd in M52d, and the reason this
 * example can be both type-checked here and deployed there.
 */
export class ReplyInboxObject {
  readonly #core: ReplyInboxObjectCore;

  constructor(ctx: IDurableObjectState, _env: CloudflareWorkerEnv) {
    this.#core = new ReplyInboxObjectCore(ctx);
  }

  fetch(request: Request): Promise<Response> {
    return this.#core.fetch(request);
  }

  webSocketClose(
    ws: IDurableObjectWebSocket,
    code: number,
    reason: string,
  ): void {
    this.#core.webSocketClose(ws, code, reason);
  }

  webSocketError(ws: IDurableObjectWebSocket): void {
    this.#core.webSocketError(ws);
  }
}

export default {
  fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    return workerHandler.fetch(request, env);
  },
  /**
   * The consumer half, which Cloudflare invokes as a MODULE EXPORT rather than
   * through `fetch` — a separate invocation from the one that published.
   */
  async queue(
    batch: IQueueMessageBatch,
    env: WorkerEnvironment,
  ): Promise<void> {
    const app = await workerHandler.application(env);
    await createMessagingHandler(app)(batch);
  },
  async scheduled(
    controller: IScheduledController,
    env: WorkerEnvironment,
  ): Promise<void> {
    await createScheduledHandler(cron)(controller);
    await env.EXAMPLE_KV.put('scheduled-runs', String(scheduledRuns));
  },
};
