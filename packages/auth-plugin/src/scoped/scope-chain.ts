/**
 * The scope chain — a check's own scope plus every scope whose grants also
 * apply in it — and the tenant-consistency rule (M110b plan §3.5, §3.6).
 *
 * Internal: not exported from the package barrel.
 *
 * @module
 */
import type { IRequestContext, ScopeRef } from '@setu-ts/common';
import { errorNameOf, readScopeRef, ScopedDeadlineError, scopeKey } from './model.ts';
import type { Bounded, Failure } from './model.ts';

/** The configuration the walk reads. */
export interface ChainConfig {
  /** The inheritance resolver; absent means flat. */
  readonly inheritsFrom:
    | ((scope: ScopeRef, signal: AbortSignal) => readonly ScopeRef[] | Promise<readonly ScopeRef[]>)
    | undefined;
  /** The deepest walk: a scope at this depth that still has parents denies. */
  readonly maxScopeDepth: number;
  /** The most scopes one walk may visit. */
  readonly maxScopeNodes: number;
}

/** A walked chain, or why the walk denied. */
export type ChainOutcome = { readonly ok: true; readonly chain: readonly ScopeRef[] } | Failure;

/**
 * Walks `inheritsFrom` depth-first from `start`.
 *
 * A scope reached again ON ITS OWN PATH is a cycle and denies; a scope reached
 * by two different paths (a diamond) is visited once. The chain is in
 * pre-order, starting with `start`, so it is deterministic for a cache key.
 * An invalid scope returned by the resolver is dropped.
 *
 * @param start - The check's own scope
 * @param config - The resolver and bounds
 * @param bounded - Runs each resolver call under the deadline
 * @returns The chain, or the failure
 */
export async function walkScopeChain(
  start: ScopeRef,
  config: ChainConfig,
  bounded: Bounded,
): Promise<ChainOutcome> {
  const inheritsFrom = config.inheritsFrom;
  if (inheritsFrom === undefined) {
    return { ok: true, chain: [start] };
  }
  const chain: ScopeRef[] = [];
  const seen = new Set<string>();

  const visit = async (
    scope: ScopeRef,
    depth: number,
    path: ReadonlySet<string>,
  ): Promise<Failure | undefined> => {
    const key = scopeKey(scope);
    if (path.has(key)) {
      return { ok: false, reason: 'scope-cycle', scopeType: scope.type };
    }
    if (seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    if (seen.size > config.maxScopeNodes) {
      return { ok: false, reason: 'scope-nodes', scopeType: scope.type };
    }
    chain.push(scope);
    let parents: readonly unknown[];
    try {
      const answered: unknown = await bounded((signal) =>
        Promise.resolve(inheritsFrom(scope, signal))
      );
      parents = Array.isArray(answered) ? answered : [];
    } catch (error) {
      return error instanceof ScopedDeadlineError
        ? { ok: false, reason: 'resolver-timeout', scopeType: scope.type }
        : {
          ok: false,
          reason: 'resolver-failed',
          scopeType: scope.type,
          errorName: errorNameOf(error),
        };
    }
    const valid: ScopeRef[] = [];
    for (const parent of parents) {
      const ref = readScopeRef(parent);
      if (ref !== undefined) {
        valid.push(ref);
      }
    }
    if (valid.length > 0 && depth >= config.maxScopeDepth) {
      return { ok: false, reason: 'scope-depth', scopeType: scope.type };
    }
    const nextPath = new Set(path).add(key);
    for (const parent of valid) {
      const failure = await visit(parent, depth + 1, nextPath);
      if (failure !== undefined) {
        return failure;
      }
    }
    return undefined;
  };

  const failure = await visit(start, 0, new Set());
  return failure ?? { ok: true, chain };
}

/**
 * Whether a check's own scope names a different tenant from the request's
 * resolved tenant (plan §3.6). Only the check's OWN scope is compared:
 * inherited scopes are reached from it. With no context, or no resolved
 * tenant, there is nothing to compare.
 *
 * @param scope - The check's own scope
 * @param context - The request, when the check came from one
 * @param tenantScopeType - The scope type that names a tenant
 * @returns `true` when the check must deny
 */
export function tenantMismatch(
  scope: ScopeRef,
  context: IRequestContext | undefined,
  tenantScopeType: string,
): boolean {
  if (context === undefined || scope.type !== tenantScopeType) {
    return false;
  }
  const tenant = context.request.tenant?.id;
  return tenant !== undefined && tenant !== scope.id;
}
