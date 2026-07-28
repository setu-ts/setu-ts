/**
 * A fake `IApplication` for the plugin-command unit tests.
 *
 * It honors the kernel's ACTUAL lifecycle contract rather than a convenient
 * approximation, because a permissive double would hide the bugs these tests
 * exist to catch:
 *
 * - `start()` records whether a port was passed, so a test can prove discovery
 *   never binds a socket.
 * - `stop()` no-ops when `start()` never completed and is idempotent, matching
 *   `application.ts:338` — otherwise a test could not tell a guaranteed
 *   teardown from a double one.
 * - `services.getAll` returns `[]` for an unregistered token rather than
 *   throwing, matching `registry.ts:105`.
 *
 * @module
 */

import type {
  CapabilityToken,
  CliCommandHandler,
  IApplication,
  IMiddlewareApi,
  IRouterApi,
  IServiceRegistry,
  StartOptions,
} from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

/** One command a fake plugin registered. */
export interface FakeCommand {
  readonly name: string;
  readonly handler: CliCommandHandler;
}

/** An `IApplication` double that records its lifecycle calls. */
export interface FakeApp extends IApplication {
  /** Options passed to each `start()` call, in order. */
  readonly startCalls: readonly (StartOptions | undefined)[];
  /** Number of times `stop()` actually ran its shutdown. */
  readonly stopCount: () => number;
  /** Whether `start()` completed successfully. */
  readonly isStarted: () => boolean;
}

/**
 * Creates a fake application exposing the given CLI commands.
 *
 * @param commands - Commands to return from `getAll(CLI_COMMAND)`
 * @param options - Set `failStart` / `failStop` to make that call reject
 * @returns The fake application
 */
export function createFakeApp(
  commands: readonly FakeCommand[] = [],
  options: { readonly failStart?: string; readonly failStop?: string } = {},
): FakeApp {
  const startCalls: (StartOptions | undefined)[] = [];
  let started = false;
  let stops = 0;

  const services = {
    getAll<T extends object>(token: CapabilityToken): readonly T[] {
      return token === CAPABILITIES.CLI_COMMAND ? (commands as unknown as readonly T[]) : [];
    },
  } as unknown as IServiceRegistry;

  const app: FakeApp = {
    startCalls,
    stopCount: () => stops,
    isStarted: () => started,

    // Present for contract completeness but never reached: the plugin-command
    // path touches only services and the lifecycle. Throwing rather than
    // returning a stub means an unexpected use shows up as a loud failure.
    get router(): IRouterApi {
      throw new Error('fake-app: router is not part of the plugin-command path');
    },
    get middleware(): IMiddlewareApi {
      throw new Error('fake-app: middleware is not part of the plugin-command path');
    },
    services,

    register() {
      return app;
    },

    start(startOptions?: StartOptions): Promise<void> {
      startCalls.push(startOptions);
      if (options.failStart !== undefined) {
        // The kernel rolls #started back to false when startup throws, so a
        // later stop() must still be a no-op.
        return Promise.reject(new Error(options.failStart));
      }
      started = true;
      return Promise.resolve();
    },

    stop(): Promise<void> {
      // Matches the kernel: a no-op when the application never started, and
      // idempotent afterwards.
      if (!started) return Promise.resolve();
      started = false;
      stops++;
      return options.failStop === undefined
        ? Promise.resolve()
        : Promise.reject(new Error(options.failStop));
    },

    fetch(): Promise<Response> {
      return Promise.resolve(new Response(null, { status: 501 }));
    },
  };

  return app;
}
