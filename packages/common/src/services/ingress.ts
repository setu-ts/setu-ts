/**
 * Transport-neutral ingress contracts: the work envelope, the behaviour
 * contract, the structural behaviour type, and the ONE composer shared by
 * every non-HTTP ingress path (queue, scheduler, messaging, websocket) and by
 * the CQRS pipeline.
 *
 * This module is the `common`-level sibling of `services/cqrs.ts`.
 * `IPipelineBehavior` is deliberately NOT widened — its
 * `TRequest extends CqrsRequest` constraint cannot describe a queue job, a
 * cron tick or a socket frame, and its CQRS result type cannot describe four
 * void-returning handlers — so the shared part is the composer, not the
 * interface.
 *
 * @module
 */

/**
 * The ingress path a unit of non-HTTP work arrived on.
 *
 * A behaviour branches on this when its concern is transport-specific (e.g.
 * reading `headers` only on the `'messaging'` arm). Exhaustive over the four
 * ingress paths the behaviour chain wraps.
 *
 * @since 0.3.0
 */
export type IngressKind = 'queue' | 'scheduler' | 'messaging' | 'websocket';

/**
 * Transport-neutral envelope for ONE unit of non-HTTP work.
 *
 * Built per work item by the dispatch site (never reused across concurrent
 * invocations) and handed to every behaviour in the chain. The wrapped handler
 * keeps its NATIVE argument (`IJob`, `ScheduledJob`, `(message, metadata)`,
 * `(conn, data)`); only the behaviour chain sees this envelope.
 *
 * There is deliberately no `state` slot and no `services` member: the envelope
 * is a per-item read-only value, and a behaviour needing a capability closes
 * over it via its `RegistryFactory` arm instead. That closed-over capability
 * is also how a TENANT concern is written: the tenant id is read from
 * `payload` and scoped through the ctx-free members of
 * `IMultiTenancyService` (`getRepositoryFor`/`prefixCacheKey`) — its
 * `IRequestContext`-taking members are unreachable from an ingress path,
 * which carries no request.
 *
 * @typeParam TPayload - The native work item the ingress carries
 * @since 0.3.0
 */
export interface IngressContext<TPayload = unknown> {
  /**
   * Which ingress path produced this work item — the discriminator a
   * behaviour branches on.
   */
  readonly kind: IngressKind;
  /**
   * The route the work is addressed by: the queue job name, the scheduler job
   * name, the broker topic, or the WebSocket route path.
   */
  readonly name: string;
  /**
   * The native work item: an `IJob`, a `ScheduledJob`, the message payload,
   * or the frame data.
   */
  readonly payload: TPayload;
  /**
   * 1-based delivery attempt. Present for `'queue'` (from `IJob.attempts`)
   * and `'scheduler'` (from `ScheduledJob.attempts`); ABSENT for
   * `'messaging'` and `'websocket'`. Absent means "this ingress cannot tell
   * you" — never "first try": brokers redeliver and none tracks a delivery
   * count, so a fabricated `1` would lie on a fifth redelivery.
   */
  readonly attempt?: number;
  /**
   * Transport headers, populated on the `'messaging'` arm only from
   * `MessageMetadata.headers`. `{}` means the channel carried none; absent
   * means there was no channel.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The structural shape both behaviour contracts satisfy, and the element type
 * of {@linkcode composeBehaviorChain}'s `behaviors` array.
 *
 * `IPipelineBehavior` and `IIngressBehavior` both satisfy this structurally —
 * neither needed to change — which is what lets one composer serve both the
 * CQRS pipeline and the four non-HTTP ingress chains.
 *
 * @typeParam TWork - The work item the behaviour wraps
 * @typeParam TResult - The chain result type
 * @since 0.3.0
 */
export interface BehaviorLike<TWork, TResult> {
  /**
   * Wraps the rest of the chain.
   *
   * @param work - The work item being handled
   * @param next - Invokes the next behaviour in declared order, ending at the
   * terminal handler
   * @returns The chain result. Returning WITHOUT calling `next` short-circuits
   * the chain: downstream behaviours and the terminal are skipped and this
   * value becomes the result.
   */
  handle(work: TWork, next: () => Promise<TResult>): TResult | Promise<TResult>;
}

/**
 * Cross-cutting behaviour around one unit of non-HTTP ingress work.
 *
 * Sibling of `IPipelineBehavior`, not a widening of it: all four ingress
 * handlers are void-returning, so `next` resolves to `void` and a behaviour
 * short-circuits by returning without calling `next()` — which skips the
 * wrapped handler. The `behaviors` arm each ingress plugin declares takes this
 * interface, directly or through a `RegistryFactory` resolved at `onInit`.
 *
 * @since 0.3.0
 */
export interface IIngressBehavior {
  /**
   * Wraps the rest of the chain around one work item.
   *
   * @param ctx - The per-item work envelope
   * @param next - Invokes the next behaviour, or the wrapped handler at the
   * end of the chain
   * @returns Nothing: ingress handlers are void-returning. Return without
   * calling `next` to short-circuit.
   */
  handle(ctx: IngressContext, next: () => Promise<void>): void | Promise<void>;
}

/**
 * Composes behaviours around a terminal handler — the ONE shared composer for
 * the CQRS pipeline and all four non-HTTP ingress chains.
 *
 * Behaviors are wrapped last-to-first so `behaviors[0]` runs first (declared
 * order = execution order). A behaviour short-circuits by returning without
 * calling `next()`, which skips the downstream behaviours and the terminal. A
 * behaviour that throws — synchronously or asynchronously — REJECTS the
 * returned promise, propagating to that ingress's existing failure path. An
 * empty array invokes the terminal exactly once.
 *
 * The implementation converts every synchronous throw into a rejected
 * promise: the declared return type is a promise, and a caller writing
 * `.catch(...)` — or `Promise.allSettled` over a batch — must see every
 * failure.
 *
 * @typeParam TWork - The work item being handled
 * @typeParam TResult - The chain result type
 * @param work - The work item being handled
 * @param behaviors - Behaviors to apply, in declared order
 * @param terminal - The terminal handler, invoked exactly once when no
 * behaviour short-circuits
 * @returns The result of the chain: the terminal's result, or the
 * short-circuiting behaviour's return value
 * @throws {Error} — as a REJECTION, never synchronously: a behaviour's throw
 * propagates to the caller
 * @example
 * ```typescript
 * const behaviors: readonly IIngressBehavior[] = [new TenantBehavior()];
 * await composeBehaviorChain<IngressContext, void>(
 *   {
 *     kind: 'queue',
 *     name: job.name,
 *     payload: job.data,
 *     attempt: job.attempts,
 *   },
 *   behaviors,
 *   () => processor(job),
 * );
 * ```
 * @since 0.3.0
 */
export function composeBehaviorChain<TWork, TResult>(
  work: TWork,
  behaviors: readonly BehaviorLike<TWork, TResult>[],
  terminal: () => Promise<TResult>,
): Promise<TResult> {
  let next = terminal;
  for (let i = behaviors.length - 1; i >= 0; i--) {
    const behavior = behaviors[i];
    const prev = next;
    // Invoke the downstream behaviour immediately so synchronous ingress
    // dispatch retains its ordering, while turning its synchronous throw into
    // the rejected promise promised by `next()`. Calling
    // `Promise.resolve(behavior.handle(...))` directly would evaluate
    // `handle` first, letting that throw escape `next()` before its promised
    // result existed.
    next = () => {
      try {
        return Promise.resolve(behavior.handle(work, prev));
      } catch (error) {
        return Promise.reject(error);
      }
    };
  }
  try {
    return next();
  } catch (error) {
    return Promise.reject(error);
  }
}
