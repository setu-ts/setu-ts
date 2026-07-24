/**
 * Internal worker-side channel plumbing for `defineWorkerTask`. NOT exported
 * from any barrel or subpath — unit tests import it via relative path.
 *
 * Channel detection is web-first and this ordering is load-bearing: Deno
 * implements `node:worker_threads` on top of web workers, so inside a Deno
 * web worker BOTH channels can appear — the pool listens on the web channel,
 * so the web channel must win. Node workers have no global `postMessage` and
 * fall through to `parentPort`.
 *
 * @module
 */

import type { WorkerErrorShape, WorkerReadySignal, WorkerTaskReply } from '@hono-enterprise/common';
import { isWorkerTaskRequest } from '@hono-enterprise/common';
import { parentPort } from 'node:worker_threads';

/**
 * The message channel a task module talks over, normalized across web worker
 * globals and `node:worker_threads` `parentPort`.
 */
export interface TaskPort {
  /** Posts a structured-clonable message to the host. */
  postMessage(message: unknown): void;
  /** Registers the listener for messages from the host. */
  onMessage(listener: (message: unknown) => void): void;
}

/** Shape of the globals probed for the web-worker channel. */
export interface WebScopeCandidate {
  postMessage?: unknown;
  onmessage?: unknown;
}

/** Shape of `parentPort` as this module uses it. */
export interface NodePortLike {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
}

/**
 * Resolves the channel to the host: the web dedicated-worker global scope
 * when it exposes `postMessage` (Deno/Bun), otherwise `parentPort` (Node).
 *
 * @param scope - Candidate global scope (defaults to `globalThis`)
 * @param nodePort - Candidate node port (defaults to the real `parentPort`)
 * @returns The normalized port
 * @throws {Error} When neither channel exists (not inside a worker)
 */
export function resolveTaskPort(
  scope: WebScopeCandidate = globalThis as WebScopeCandidate,
  nodePort: NodePortLike | null = parentPort,
): TaskPort {
  if (typeof scope.postMessage === 'function') {
    const web = scope as {
      postMessage(message: unknown): void;
      onmessage: ((event: { data: unknown }) => void) | null;
    };
    return {
      postMessage: (message: unknown) => web.postMessage(message),
      onMessage: (listener: (message: unknown) => void) => {
        web.onmessage = (event) => listener(event.data);
      },
    };
  }
  if (nodePort !== null) {
    return {
      postMessage: (message: unknown) => nodePort.postMessage(message),
      onMessage: (listener: (message: unknown) => void) => {
        nodePort.on('message', listener);
      },
    };
  }
  throw new Error(
    'defineWorkerTask() must be called inside a worker (no worker message channel found)',
  );
}

/** Serializes a thrown value to the protocol's error shape. */
function toErrorShape(err: unknown): WorkerErrorShape {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      ...(err.stack !== undefined ? { stack: err.stack } : {}),
    };
  }
  return { name: 'Error', message: String(err) };
}

/**
 * Wires a task handler onto a port: replies to task requests, ignores
 * non-protocol messages, and posts the ready signal.
 *
 * @param fn - The task handler
 * @param port - The channel to the host
 */
export function wireWorkerTask<TInput, TOutput>(
  fn: (input: TInput) => TOutput | Promise<TOutput>,
  port: TaskPort,
): void {
  port.onMessage((message: unknown) => {
    if (!isWorkerTaskRequest(message)) {
      return;
    }
    void (async () => {
      let reply: WorkerTaskReply;
      try {
        // The pool posts what the caller passed to run<TInput, …>; the cast
        // re-attaches the type erased by structured clone.
        const result = await fn(message.input as TInput);
        reply = { __hewp: 1, kind: 'reply', id: message.id, ok: true, result };
      } catch (err) {
        reply = { __hewp: 1, kind: 'reply', id: message.id, ok: false, error: toErrorShape(err) };
      }
      port.postMessage(reply);
    })();
  });
  const ready: WorkerReadySignal = { __hewp: 1, kind: 'ready' };
  port.postMessage(ready);
}
