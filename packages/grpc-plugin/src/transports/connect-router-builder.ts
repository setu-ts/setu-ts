/**
 * Connect router builder — registers the application's services plus the
 * plugin's own health and reflection services onto a Connect router, then maps
 * every resulting `UniversalHandler` into a dispatch map keyed by full request
 * path.
 *
 * Connect's `router.service()` requires a real Protobuf-ES `DescService`: it
 * walks the method descriptors' input/output field descriptors to serialize
 * bodies. A hand-built `{ typeName, methods: {…} }` object makes Connect throw
 * `service.methods is not iterable`, and one whose messages declare no fields
 * serializes every response to `{}`. Applications therefore register generated
 * descriptors (or ones revived from an embedded `FileDescriptorSet`), and this
 * builder passes them straight through.
 *
 * @module
 */

import { normalizeBasePath } from './rpc-dispatcher.ts';
import {
  buildReflectionRegistry,
  reviveServiceDescriptor,
} from '../descriptors/descriptor-registry.ts';
import { createHealthService } from '../health/grpc-health-bridge.ts';
import { createReflectionService } from '../reflection/grpc-reflection.ts';
import type {
  ConnectRuntime,
  FileDescriptorLike,
  ServiceDescriptorLike,
} from '../interfaces/connect-runtime.ts';
import type { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';
import type { IHealthService, ILogger } from '@setu-ts/common';
import { serializeError } from '@setu-ts/common';

/** Fully-qualified name of the built-in health service. */
const HEALTH_SERVICE_NAME = 'grpc.health.v1.Health';
/** Fully-qualified name of the built-in reflection service. */
const REFLECTION_SERVICE_NAME = 'grpc.reflection.v1.ServerReflection';

/** A service the builder registers. */
export interface ServiceEntry {
  readonly definition: unknown;
  readonly implementation?: unknown;
}

/** Inputs to {@linkcode buildConnectRouter}. */
export interface BuildConnectRouterOptions {
  readonly connectRuntime: ConnectRuntime;
  readonly basePath: string;
  readonly reflection: boolean;
  readonly health: boolean;
  readonly services: readonly ServiceEntry[];
  readonly embeddedDescriptors: EmbeddedDescriptors;
  readonly healthService: IHealthService | undefined;
  /**
   * Resolves the logger at RPC-call time (M52b lesson: read per call, not
   * captured at `register()`, so a logger registered by a later plugin is seen).
   * Returns `undefined` when no logger is registered. Used to log handler
   * failures (X7-5) without changing the masked wire response. Omitted (or
   * `undefined`) when no logging is wanted: the implementation is then passed
   * through unwrapped.
   */
  readonly resolveLogger?: (() => ILogger | undefined) | undefined;
  /**
   * Application-supplied Connect interceptors, forwarded to
   * `createConnectRouter({ interceptors })` (M70f §3.7). The plugin's built-in
   * handler-error logging wraps each application service's implementation
   * (innermost), so a handler throw is logged before an application
   * interceptor observes it.
   */
  readonly interceptors?: readonly unknown[] | undefined;
}

/**
 * Builds the Connect router and the dispatch map.
 *
 * @returns The dispatch map, keyed `basePath + handler.requestPath`.
 * @throws {Error} If two registered services share a `typeName`.
 * @throws {GrpcDescriptorError} If an embedded descriptor set is unusable.
 */
export function buildConnectRouter(options: BuildConnectRouterOptions): {
  dispatchMap: Map<string, (request: Request) => Promise<Response>>;
} {
  const {
    connectRuntime,
    basePath,
    reflection,
    health,
    services,
    embeddedDescriptors,
    healthService,
    resolveLogger,
    interceptors,
  } = options;

  const normalizedBase = normalizeBasePath(basePath);
  // Thread the application's interceptors into the router (M70f §3.7). The
  // built-in handler-error logging is innermost — it wraps each application
  // service's implementation — so a handler throw is logged before any
  // application interceptor observes it.
  const router = connectRuntime.createConnectRouter({ interceptors });

  // Application services first, so their names lead `list_services`.
  const serviceNames: string[] = [];
  const reflectionFiles: (FileDescriptorLike | undefined)[] = [];
  const seenTypeNames = new Set<string>();

  for (const entry of services) {
    const definition = entry.definition as ServiceDescriptorLike;
    if (seenTypeNames.has(definition.typeName)) {
      throw new Error(`Service '${definition.typeName}' has already been registered`);
    }
    seenTypeNames.add(definition.typeName);
    serviceNames.push(definition.typeName);
    reflectionFiles.push(definition.file);
    // Wrap the application's implementation so a throwing handler is logged
    // (X7-5) before Connect masks it into a wire error. The built-in health and
    // reflection services are NOT wrapped — they are framework-owned and their
    // failures are not application handler errors.
    router.service(
      definition,
      withErrorLogging(
        definition,
        (entry.implementation ?? {}) as Record<string, unknown>,
        resolveLogger,
      ),
    );
  }

  // The built-in health service.
  let healthDescriptor: ServiceDescriptorLike | undefined;
  if (health) {
    healthDescriptor = reviveServiceDescriptor(
      connectRuntime,
      embeddedDescriptors.healthBase64,
      HEALTH_SERVICE_NAME,
    );
    serviceNames.push(HEALTH_SERVICE_NAME);
    reflectionFiles.push(healthDescriptor.file);
  }

  // The built-in reflection service.
  let reflectionDescriptor: ServiceDescriptorLike | undefined;
  if (reflection) {
    reflectionDescriptor = reviveServiceDescriptor(
      connectRuntime,
      embeddedDescriptors.reflectionBase64,
      REFLECTION_SERVICE_NAME,
    );
    serviceNames.push(REFLECTION_SERVICE_NAME);
    reflectionFiles.push(reflectionDescriptor.file);
  }

  // Registered after the name list is complete: `Check` answers SERVICE_UNKNOWN
  // for a name the server does not serve, and reflection lists them all.
  if (healthDescriptor !== undefined) {
    router.service(healthDescriptor, createHealthService(healthService, serviceNames));
  }
  if (reflectionDescriptor !== undefined) {
    const registry = buildReflectionRegistry(connectRuntime, reflectionFiles, serviceNames);
    router.service(reflectionDescriptor, createReflectionService(registry));
  }

  const dispatchMap = new Map<string, (request: Request) => Promise<Response>>();
  for (const handler of router.handlers) {
    dispatchMap.set(
      normalizedBase + handler.requestPath,
      connectRuntime.createFetchHandler(handler),
    );
  }

  return { dispatchMap };
}

/**
 * Wraps a service implementation's procedures so a thrown handler error is
 * logged at `error` level — with the procedure name and a serialized error
 * (X7-5) — and then rethrown, leaving Connect's masked wire response unchanged.
 *
 * Procedures are resolved the same way Connect resolves them: by the service
 * descriptor's declared method names and a property lookup on the
 * implementation (`impl[method.localName]` in `@connectrpc/connect`'s
 * `createServiceImplSpec`), NOT by enumerating the implementation's own
 * properties. Enumerating own properties only (`Object.entries`) misses every
 * method that lives on a class instance's prototype — the most common shape
 * for a hand-written implementation — so a throwing class method was never
 * wrapped and never logged. Property lookup finds prototype methods, and the
 * wrapped function is bound to the implementation so `this` still refers to
 * the application's object when Connect invokes it.
 *
 * The logger is resolved per call through `resolveLogger` so a logger
 * registered after the router was built is still seen (M52b). When no logger
 * is present the error is simply rethrown. A Connect-ES implementation maps
 * each method to a single function, so only function values are wrapped; any
 * non-function value passes through untouched.
 *
 * @param definition - The service descriptor (declared method names + name)
 * @param implementation - The application's implementation object
 * @param resolveLogger - Resolves the logger at call time
 * @returns A wrapped implementation (the same object when there is no logger and nothing to wrap)
 */
function withErrorLogging(
  definition: ServiceDescriptorLike,
  implementation: Record<string, unknown>,
  resolveLogger: (() => ILogger | undefined) | undefined,
): Record<string, unknown> {
  // No logger → nothing to log → pass the implementation through untouched
  // (the same object), exactly as before the logging wrapper existed.
  if (resolveLogger === undefined) {
    return implementation;
  }
  let out: Record<string, unknown> | undefined;
  for (const method of definition.methods ?? []) {
    // Connect looks the procedure up by its camelCase local name, falling back
    // to the proto name; mirror that so the wrap matches what Connect invokes.
    const key = method.localName ?? method.name;
    const value = implementation[key];
    if (typeof value !== 'function') {
      continue;
    }
    // Bind the wrapped function to the implementation so a class method's
    // `this` still refers to the application's object when Connect invokes it
    // (Connect itself rebinds to the implementation; the bind here keeps the
    // wrapper correct if it is ever called unbound).
    const wrapped = guardProcedure(
      definition.typeName,
      key,
      (value as (...args: unknown[]) => unknown).bind(implementation),
      resolveLogger,
    );
    if (wrapped !== value) {
      out ??= { ...implementation };
      out[key] = wrapped;
    }
  }
  return out ?? implementation;
}

/**
 * True when a value settles like a Promise (has a callable `.then`).
 *
 * A JavaScript thenable may be an object OR a function (a callable object is
 * a legal thenable — `Promise.resolve(fn)` invokes `fn.then`). Recognizing
 * only `object` candidates let a callable rejecting thenable skip assimilation
 * and be returned unchanged, so its rejection never reached the logging path
 * (M70f code review, finding 1).
 */
function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** True when a value is an async iterable (has a callable `[Symbol.asyncIterator]`). */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

/**
 * Wraps one procedure function: on a handler error, logs it (when a logger is
 * resolvable) and rethrows so the masked wire response is unchanged.
 *
 * The wrapper is **synchronous**, not `async`: a server-streaming implementation
 * returns an `AsyncIterable` directly (not a `Promise`), and an `async` wrapper
 * would box that iterable in a `Promise` that Connect cannot iterate — the
 * stream would yield nothing. The wrapper therefore forwards every argument and
 * handles three result shapes:
 *
 * - a synchronous throw — caught, logged, and rethrown;
 * - a thenable (a unary `Promise`) — a rejection handler is attached that logs
 *   and rethrows;
 * - an `AsyncIterable` (server-streaming or bidi) — wrapped in a transparent
 *   iterable that delegates values, `return`, and `throw`, but logs (and
 *   rethrows) a failure that surfaces from a later `next()`. A streaming
 *   handler's common failure point is a `next()` rejection AFTER invocation has
 *   returned, so without this the error would be logged nowhere (M70f
 *   re-review, finding 3).
 *
 * A non-thenable, non-iterable result (a unary value) is returned unchanged.
 *
 * The thenable/iterable inspection is itself guarded (M70f code review,
 * finding 2): it reads `result.then` and `result[Symbol.asyncIterator]`,
 * property accesses that can throw when the property is a throwing accessor.
 * That happens after the handler invocation's protected `try` has ended, so
 * an unguarded read would let a throwing `then` getter escape synchronously
 * without ever reaching the logging path. Any inspection failure is a
 * handler failure and is logged and rethrown like a synchronous throw.
 */
function guardProcedure(
  typeName: string,
  method: string,
  fn: (...args: unknown[]) => unknown,
  resolveLogger: () => ILogger | undefined,
): (...args: unknown[]) => unknown {
  const procedure = `${typeName}/${method}`;
  // Logs the error (when a logger resolves) and rethrows it so the masked
  // wire response is unchanged. Used for the synchronous, the thenable-
  // rejection, and the async-iteration paths.
  //
  // The logger RESOLUTION and EMISSION are each guarded (M70f re-review,
  // finding 4): a broken logger — one whose `error()` throws, or whose
  // resolution throws — must degrade silently rather than REPLACE the handler
  // error. Without the guards, a logger failure would escape `reportAndRethrow`
  // before the `throw error`, and an outer interceptor would observe the logger
  // failure instead of the handler failure.
  const reportAndRethrow = (error: unknown): never => {
    try {
      const logger = resolveLogger();
      if (logger !== undefined) {
        logger.error('gRPC handler failed', {
          procedure,
          ...serializeError(error),
        });
      }
    } catch {
      // The logger itself failed (or could not be resolved). No safe channel
      // remains; degrade silently so the ORIGINAL handler error below is the
      // one that propagates.
    }
    throw error;
  };
  return (...args: unknown[]) => {
    let result: unknown;
    try {
      result = fn(...args);
    } catch (error) {
      reportAndRethrow(error);
    }
    // The inspection below reads `result.then` and
    // `result[Symbol.asyncIterator]` — property accesses that can themselves
    // throw (an accessor whose getter throws). They run AFTER the handler
    // invocation's protected `try` has ended, so without this guard a
    // throwing `then` getter would escape synchronously without ever
    // reaching `reportAndRethrow` (M70f code review, finding 2). The guard
    // routes any inspection failure through the same protected path and
    // rethrows the ORIGINAL error.
    try {
      if (isThenable(result)) {
        // Assimilate with a native Promise before attaching the rejection
        // handler: `isThenable` accepts any object or function with a
        // callable `then`, and a non-native thenable may expose no `catch` of
        // its own — calling `result.catch(...)` directly would throw a
        // replacement `TypeError` and swallow the original rejection (M70f
        // re-review round 2, finding 2). `Promise.resolve` invokes the
        // thenable's `then` and yields a native promise, so the rejection
        // handler below is reached for native and custom thenables alike.
        return Promise.resolve(result).catch((error) => reportAndRethrow(error));
      }
      if (isAsyncIterable(result)) {
        return withErrorLoggingIterable(result, (error) => reportAndRethrow(error));
      }
    } catch (error) {
      reportAndRethrow(error);
    }
    return result;
  };
}

/**
 * Wraps an `AsyncIterable` in a transparent iterable that logs (and rethrows)
 * ANY failure surfacing from the underlying iterator — a synchronous throw
 * while acquiring the iterator, a `next()` rejection, or a rejected delegated
 * `return`/`throw` — while preserving cancellation (`return`) and error
 * propagation (`throw`) to the underlying iterator (M70f re-review round 2,
 * finding 3).
 *
 * The wrapper is **lazy**: it does not call `iterator()` until the consumer
 * does, so a handler that returns an iterable but is never consumed does not
 * start the underlying work. Every operation is delegated verbatim, and every
 * failure it can surface is routed through the SAME protected `report` path
 * used for `next()`: `report` logs the failure (degrading silently if the
 * logger itself fails) and rethrows the ORIGINAL error, leaving Connect's
 * masked wire response unchanged.
 *
 * @param source - The implementation's async iterable result
 * @param report - Logs the iteration failure and rethrows it
 * @returns A transparent wrapper iterable
 */
function withErrorLoggingIterable(
  source: AsyncIterable<unknown>,
  report: (error: unknown) => never,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      // Guard iterator ACQUISITION: a synchronous throw from the underlying
      // `iterator()` factory (e.g. a cursor that fails to open) is a handler
      // failure just like a `next()` rejection, and must reach the same
      // reporting path rather than escaping unlogged.
      let iterator: AsyncIterator<unknown>;
      try {
        iterator = source[Symbol.asyncIterator]();
      } catch (error) {
        report(error);
      }
      return {
        async next(...args: [] | [unknown]): Promise<IteratorResult<unknown>> {
          try {
            return await iterator.next(...args);
          } catch (error) {
            report(error);
          }
        },
        // Preserve cancellation and error propagation to the underlying
        // iterator so the handler's cleanup (e.g. closing a cursor) still runs.
        // A REJECTED cleanup is a handler failure too: route it through the
        // same reporting path so it is logged, and rethrow the ORIGINAL error
        // (`report` degrades silently if the logger itself fails).
        async return(value?: unknown): Promise<IteratorResult<unknown>> {
          try {
            return await (
              iterator.return?.(value) ??
                Promise.resolve({ value: undefined, done: true })
            );
          } catch (error) {
            report(error);
          }
        },
        async throw(error?: unknown): Promise<IteratorResult<unknown>> {
          try {
            return await (iterator.throw?.(error) ?? Promise.reject(error));
          } catch (err) {
            report(err);
          }
        },
      };
    },
  };
}
