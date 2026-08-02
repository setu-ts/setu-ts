/**
 * `ICloudflareBindings` and its implementation — the typed view over a Worker's
 * `env` published under `CAPABILITIES.CLOUDFLARE`.
 *
 * @module
 */

import type { WaitUntilHost } from '../background/wait-until.ts';
import { CloudflareBindingMissingError } from '../errors.ts';
import type {
  ID1Database,
  IDurableObjectNamespace,
  IKvNamespace,
  IQueueProducer,
  IR2Bucket,
  IServiceBinding,
} from './facades.ts';
import { isKvNamespace, isR2Bucket } from './facades.ts';

/**
 * Typed access to a Cloudflare Worker's platform bindings.
 *
 * Resolve it from the service registry under `CAPABILITIES.CLOUDFLARE`.
 *
 * Every accessor **throws** {@linkcode CloudflareBindingMissingError} for a
 * name the Worker does not carry, rather than returning `undefined`: a missing
 * binding is a deployment error, and failing with the requested name plus the
 * names that are present says what to fix. Use {@linkcode has} when absence is
 * an expected case.
 *
 * Binding **methods** may only be called inside a request. The Workers platform
 * prohibits I/O in top-level scope, so holding a binding at registration time
 * is fine while reading through it there is not.
 *
 * @example
 * ```typescript
 * const cf = ctx.services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE);
 * const value = await cf.kv('SETTINGS').get('theme');
 * cf.waitUntil(reportUsage(value));
 * ```
 * @since 0.2.0
 */
export interface ICloudflareBindings {
  /**
   * Reports whether a binding of that name is present.
   *
   * @param name - The binding name from `wrangler.toml`
   * @returns `true` when the Worker carries it
   */
  has(name: string): boolean;
  /**
   * Every binding name the Worker carries, sorted.
   *
   * @returns The binding names
   */
  names(): readonly string[];
  /**
   * The Worker's string variables and secrets.
   *
   * The same values reach `runtime.env` when the application passes `env` to
   * `RuntimePlugin`; this accessor exists so a consumer holding only the
   * bindings service does not need the runtime as well.
   *
   * @returns The string entries of the Worker's `env`
   */
  vars(): Readonly<Record<string, string>>;
  /**
   * A binding of a type this package has no facade for — Hyperdrive,
   * Vectorize, Workers AI, Analytics Engine, and anything Cloudflare ships
   * next.
   *
   * @typeParam T - The caller's own type for the binding
   * @param name - The binding name
   * @returns The binding
   * @throws {CloudflareBindingMissingError} When the binding is absent
   */
  get<T>(name: string): T;
  /**
   * A KV namespace binding.
   *
   * @param name - The binding name
   * @returns The KV namespace
   * @throws {CloudflareBindingMissingError} When absent, or not KV-shaped
   */
  kv(name: string): IKvNamespace;
  /**
   * An R2 bucket binding.
   *
   * @param name - The binding name
   * @returns The R2 bucket
   * @throws {CloudflareBindingMissingError} When absent, or not R2-shaped
   */
  r2(name: string): IR2Bucket;
  /**
   * A D1 database binding.
   *
   * @param name - The binding name
   * @returns The D1 database
   * @throws {CloudflareBindingMissingError} When the binding is absent
   */
  d1(name: string): ID1Database;
  /**
   * A Queues producer binding.
   *
   * @param name - The binding name
   * @returns The queue producer
   * @throws {CloudflareBindingMissingError} When the binding is absent
   */
  queue(name: string): IQueueProducer;
  /**
   * A service binding to another Worker.
   *
   * @param name - The binding name
   * @returns The service binding
   * @throws {CloudflareBindingMissingError} When the binding is absent
   */
  service(name: string): IServiceBinding;
  /**
   * A Durable Object namespace binding.
   *
   * @param name - The binding name
   * @returns The Durable Object namespace
   * @throws {CloudflareBindingMissingError} When the binding is absent
   */
  durableObject(name: string): IDurableObjectNamespace;
  /**
   * Keeps the invocation alive until the promise settles, so work can outlive
   * the response.
   *
   * Cloudflare allows up to 30 seconds after the invocation ends, shared across
   * every call in one request. A rejection is logged rather than left
   * unhandled. Off Cloudflare Workers — with no host injected — the promise
   * simply runs, because no runtime there cuts work off at the response.
   *
   * @param promise - The background work
   */
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * The concrete {@linkcode ICloudflareBindings}.
 *
 * Not exported from the package barrel: consumers resolve the interface from
 * the registry, per AI_GUIDELINES §1.6.
 *
 * @internal
 */
export class BindingRegistry implements ICloudflareBindings {
  readonly #bindings: Readonly<Record<string, object>>;
  readonly #vars: Readonly<Record<string, string>>;
  readonly #waitUntil: WaitUntilHost;
  readonly #names: readonly string[];

  /**
   * @param bindings - The object entries of the Worker's `env`
   * @param vars - The string entries of the Worker's `env`
   * @param waitUntil - The resolved background-work sink
   */
  constructor(
    bindings: Readonly<Record<string, object>>,
    vars: Readonly<Record<string, string>>,
    waitUntil: WaitUntilHost,
  ) {
    this.#bindings = bindings;
    this.#vars = vars;
    this.#waitUntil = waitUntil;
    // Sorted once here rather than per call: names() feeds the health
    // indicator and every error message, and the set never changes.
    this.#names = Object.keys(bindings).sort();
  }

  has(name: string): boolean {
    return Object.hasOwn(this.#bindings, name);
  }

  names(): readonly string[] {
    return this.#names;
  }

  vars(): Readonly<Record<string, string>> {
    return this.#vars;
  }

  get<T>(name: string): T {
    return this.#require(name) as T;
  }

  kv(name: string): IKvNamespace {
    const binding = this.#require(name);
    if (!isKvNamespace(binding)) {
      throw CloudflareBindingMissingError.wrongShape(name, 'a KV namespace');
    }
    return binding;
  }

  r2(name: string): IR2Bucket {
    const binding = this.#require(name);
    if (!isR2Bucket(binding)) {
      throw CloudflareBindingMissingError.wrongShape(name, 'an R2 bucket');
    }
    return binding;
  }

  d1(name: string): ID1Database {
    return this.#require(name) as ID1Database;
  }

  queue(name: string): IQueueProducer {
    return this.#require(name) as IQueueProducer;
  }

  service(name: string): IServiceBinding {
    return this.#require(name) as IServiceBinding;
  }

  durableObject(name: string): IDurableObjectNamespace {
    return this.#require(name) as IDurableObjectNamespace;
  }

  waitUntil(promise: Promise<unknown>): void {
    this.#waitUntil(promise);
  }

  /** Reads a binding, throwing with the available names when it is absent. */
  #require(name: string): object {
    const binding = this.#bindings[name];
    if (binding === undefined) {
      throw CloudflareBindingMissingError.absent(name, this.#names);
    }
    return binding;
  }
}
