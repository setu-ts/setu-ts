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
import type { IKernelApplication } from '@setu-ts/kernel';
import { createApp } from './setu.config.ts';

interface WorkerEnvironment extends CloudflareWorkerEnv {
  readonly EXAMPLE_KV: { put(key: string, value: string): Promise<void> };
}

let scheduledRuns = 0;
const cron = new WorkersCron().on('*/5 * * * *', () => {
  scheduledRuns += 1;
  return Promise.resolve();
});

/** The Worker's `fetch` path, plus the started application its other exports reuse. */
export interface WorkerHandler {
  fetch(request: Request, env: WorkerEnvironment): Promise<Response>;
  /**
   * The application `fetch` started.
   *
   * The `queue` export must dispatch into this same application: a second one
   * would hold its own broker, and the subscriptions registered on one would be
   * invisible to the other.
   */
  application(env: WorkerEnvironment): Promise<IKernelApplication>;
}

/**
 * Starts the application once per isolate and shares it between invocations.
 *
 * Concurrent callers share one start. A failed start is forgotten, so the next
 * request retries it instead of the isolate failing for its whole life.
 */
export function createWorkerHandler(
  build: (env: WorkerEnvironment) => IKernelApplication = createApp,
): WorkerHandler {
  let started: Promise<IKernelApplication> | undefined;

  const application = (env: WorkerEnvironment): Promise<IKernelApplication> => {
    if (started === undefined) {
      const attempt = (async () => {
        const app = build(env);
        await app.start();
        return app;
      })();
      started = attempt;
      attempt.catch(() => {
        started = undefined;
      });
    }
    return started;
  };

  return {
    fetch: (request, env) => application(env).then((app) => app.fetch(request)),
    application,
  };
}

const workerHandler = createWorkerHandler();

/**
 * The Durable Object that holds request/reply inboxes.
 *
 * Not `extends DurableObject`: that class lives in `cloudflare:workers`, which
 * only a Worker toolchain resolves. workerd accepts a plain `(ctx, env)` class.
 */
export class ReplyInboxObject {
  readonly #core: ReplyInboxObjectCore;

  constructor(ctx: IDurableObjectState, _env: CloudflareWorkerEnv) {
    this.#core = new ReplyInboxObjectCore(ctx);
  }

  fetch(request: Request): Promise<Response> {
    return this.#core.fetch(request);
  }

  webSocketClose(ws: IDurableObjectWebSocket, code: number, reason: string): void {
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

  /** Cloudflare delivers queue messages here, in a separate invocation from the publish. */
  async queue(batch: IQueueMessageBatch, env: WorkerEnvironment): Promise<void> {
    await createMessagingHandler(await workerHandler.application(env))(batch);
  },

  async scheduled(controller: IScheduledController, env: WorkerEnvironment): Promise<void> {
    await createScheduledHandler(cron)(controller);
    await env.EXAMPLE_KV.put('scheduled-runs', String(scheduledRuns));
  },
};
