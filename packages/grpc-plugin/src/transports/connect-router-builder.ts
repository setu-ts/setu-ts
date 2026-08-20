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
  } = options;

  const normalizedBase = normalizeBasePath(basePath);
  const router = connectRuntime.createConnectRouter();

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
        definition.typeName,
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
 * Wraps a service implementation's methods so a thrown handler error is logged
 * at `error` level — with the procedure name and a serialized error (X7-5) —
 * and then rethrown, leaving Connect's masked wire response unchanged.
 *
 * The logger is resolved per call through `resolveLogger` so a logger registered
 * after the router was built is still seen (M52b). When no logger is present the
 * error is simply rethrown. A Connect-ES implementation maps each method to a
 * single function (`{ method: fn }`), so only function values are wrapped; any
 * non-function value passes through untouched.
 *
 * @param typeName - The service's fully-qualified name (for the procedure label)
 * @param implementation - The application's implementation object
 * @param resolveLogger - Resolves the logger at call time
 * @returns A wrapped implementation (the same object when there is no logger and nothing to wrap)
 */
function withErrorLogging(
  typeName: string,
  implementation: Record<string, unknown>,
  resolveLogger: (() => ILogger | undefined) | undefined,
): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const [method, value] of Object.entries(implementation)) {
    if (typeof value !== 'function') {
      continue;
    }
    const wrapped = guardProcedure(
      typeName,
      method,
      value as (...args: unknown[]) => unknown,
      resolveLogger,
    );
    if (wrapped !== value) {
      out ??= { ...implementation };
      out[method] = wrapped;
    }
  }
  return out ?? implementation;
}

/** True when a value settles like a Promise (has a callable `.then`). */
function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Wraps one procedure function: on a handler error, logs it (when a logger is
 * resolvable) and rethrows so the masked wire response is unchanged.
 *
 * The wrapper is **synchronous**, not `async`: a server-streaming implementation
 * returns an `AsyncIterable` directly (not a `Promise`), and an `async` wrapper
 * would box that iterable in a `Promise` that Connect cannot iterate — the
 * stream would yield nothing. The wrapper therefore forwards every argument,
 * returns the implementation's result unchanged when it is not a thenable, and
 * only attaches a rejection handler when the result IS a thenable (a unary
 * `Promise`). A synchronous throw is caught, logged, and rethrown.
 */
function guardProcedure(
  typeName: string,
  method: string,
  fn: (...args: unknown[]) => unknown,
  resolveLogger: (() => ILogger | undefined) | undefined,
): (...args: unknown[]) => unknown {
  if (resolveLogger === undefined) {
    return fn;
  }
  const procedure = `${typeName}/${method}`;
  // Logs the error (when a logger resolves) and rethrows it so the masked
  // wire response is unchanged. Used for both the synchronous and the
  // thenable-rejection paths.
  const reportAndRethrow = (error: unknown): never => {
    const logger = resolveLogger();
    if (logger !== undefined) {
      logger.error('gRPC handler failed', {
        procedure,
        ...serializeError(error),
      });
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
    if (isThenable(result)) {
      return result.catch((error) => reportAndRethrow(error));
    }
    return result;
  };
}
