/**
 * Compile-time contract tests for the M86 ingress behaviour contract
 * (plan §3.1–§3.3).
 *
 * These assertions are decided by `deno task check` — if the envelope gains a
 * member (`state`, `services`), loses a `readonly`, or the kind union drifts,
 * this file stops compiling. Runtime expectations are asserted alongside so
 * the file also fails loudly under `deno task test`.
 *
 * `IPipelineBehavior` (services/cqrs.ts) is UNTOUCHED by M86: the assertions
 * below prove it still carries its committed signature AND satisfies
 * `BehaviorLike` structurally, which is what lets one composer serve both
 * contracts.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { CqrsRequest, IPipelineBehavior } from '../../src/services/cqrs.ts';
import type {
  BehaviorLike,
  IIngressBehavior,
  IngressContext,
  IngressKind,
} from '../../src/services/ingress.ts';

/**
 * Strict identity check: `true` only when `A` and `B` are the same type
 * (mutually assignable in the identity sense), so each pinned shape below
 * fails on any added, removed, or re-typed member.
 */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true
  : false;

// Compile-time: the envelope is pinned to exactly the §3.3 members, all
// readonly, with `attempt` and `headers` OPTIONAL (`exactOptionalPropertyTypes`
// — `attempt?: number`, never `attempt?: number | undefined`). Adding a
// `state` slot or a `services` member, or demoting a `readonly`, stops this
// file compiling.
type PinnedEnvelope = {
  readonly kind: IngressKind;
  readonly name: string;
  readonly payload: unknown;
  readonly attempt?: number;
  readonly headers?: Readonly<Record<string, string>>;
};
const envelopeShapePinned: Equals<IngressContext, PinnedEnvelope> = true;

// Compile-time: the kind union is pinned to exactly the four ingress paths.
const kindUnionPinned: Equals<
  IngressKind,
  'queue' | 'scheduler' | 'messaging' | 'websocket'
> = true;

// Compile-time: under `exactOptionalPropertyTypes` a type whose `attempt` is
// REQUIRED and admits `undefined` is NOT assignable to the envelope's optional
// `attempt?: number` — absent is not a fabricated value.
type AdmitsUndefinedAttempt = {
  readonly kind: IngressKind;
  readonly name: string;
  readonly payload: unknown;
  readonly attempt: number | undefined;
};
const admitsUndefinedAttempt: AdmitsUndefinedAttempt = {
  kind: 'queue',
  name: 'email.send',
  payload: 1,
  attempt: undefined,
};
// @ts-expect-error a required `attempt: number | undefined` is not assignable
// to the envelope's optional `attempt?: number` under exactOptionalPropertyTypes
const rejectsUndefinedAttempt: IngressContext = admitsUndefinedAttempt;

/**
 * Exhaustive over `IngressKind`: with `noImplicitReturns`, adding a member to
 * the union without a matching case stops this file compiling.
 */
function kindLabel(kind: IngressKind): string {
  switch (kind) {
    case 'queue':
      return 'queue';
    case 'scheduler':
      return 'scheduler';
    case 'messaging':
      return 'messaging';
    case 'websocket':
      return 'websocket';
  }
}

// Compile-time proof that `IPipelineBehavior` keeps its committed signature
// (constrained to `CqrsRequest`, returning `TResult | Promise<TResult>`) and
// satisfies `BehaviorLike` structurally — the one-composer property of §3.2.
// Expressed as a function so the assignability is checked at declaration.
function acceptsPipelineBehavior(
  behavior: IPipelineBehavior<CqrsRequest, unknown>,
): BehaviorLike<CqrsRequest, unknown> {
  return behavior;
}

// The same proof for the ingress sibling: any `IIngressBehavior` is accepted
// where a `BehaviorLike<IngressContext, void>` is required.
function acceptsIngressBehavior(
  behavior: IIngressBehavior,
): BehaviorLike<IngressContext, void> {
  return behavior;
}

describe('IngressContext contract (M86 §3.3)', () => {
  it('carries exactly the pinned readonly members (compile-time pinned)', () => {
    expect(envelopeShapePinned).toBe(true);
  });

  it('omits `attempt` on the arms that cannot know it, and carries it 1-based on queue', () => {
    const queue: IngressContext = {
      kind: 'queue',
      name: 'email.send',
      payload: { to: 'ada@example.com' },
      attempt: 2,
    };
    const websocket: IngressContext = { kind: 'websocket', name: '/ws/room', payload: 'frame' };

    expect(queue.attempt).toBe(2);
    expect(queue.headers).toBeUndefined();
    expect(websocket.attempt).toBeUndefined();
  });

  it('rejects an explicit `attempt: undefined` at compile time', () => {
    // Decided at compile time by the @ts-expect-error directive above; the
    // runtime assertion keeps the file failing loudly under `deno task test`.
    expect(rejectsUndefinedAttempt.name).toBe('email.send');
    expect(admitsUndefinedAttempt.attempt).toBeUndefined();
  });
});

describe('IngressKind (M86 §3.3)', () => {
  it('is pinned to the four ingress paths', () => {
    expect(kindUnionPinned).toBe(true);
  });

  it('is exhaustive over a switch', () => {
    expect(kindLabel('queue')).toBe('queue');
    expect(kindLabel('scheduler')).toBe('scheduler');
    expect(kindLabel('messaging')).toBe('messaging');
    expect(kindLabel('websocket')).toBe('websocket');
  });
});

describe('Behaviour contracts satisfy BehaviorLike structurally (M86 §3.1–§3.2)', () => {
  it('admits an IPipelineBehavior where BehaviorLike<CqrsRequest, unknown> is required', () => {
    const behavior: IPipelineBehavior<CqrsRequest, unknown> = {
      handle: (request, next) => {
        if (request.type.length === 0) return undefined;
        return next();
      },
    };

    expect(acceptsPipelineBehavior(behavior)).toBe(behavior);
  });

  it('admits an IIngressBehavior where BehaviorLike<IngressContext, void> is required', () => {
    const behavior: IIngressBehavior = {
      handle: (ctx, next) => {
        if (ctx.kind === 'websocket') return next();
        return next();
      },
    };

    expect(acceptsIngressBehavior(behavior)).toBe(behavior);
  });
});
