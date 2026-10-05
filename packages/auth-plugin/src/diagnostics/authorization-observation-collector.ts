/**
 * The M98h authorization-observation collector: the bounded, identity-free
 * explanation of the first-party RBAC evaluation.
 *
 * The collector IS the {@linkcode AuthorizationObserver} the `RbacService`
 * looks up on every check. It receives only evaluation facts — requested rule
 * names, per-step results and reasons, and the granting role name — never the
 * principal. It aliases those names against the application-approved maps and
 * retains at most 1,024 decisions in a bounded ring, dropping any decision
 * whose requested rules are not all approved and counting the drop in
 * `droppedUnapproved`.
 *
 * The collector verifies, before every buffer and every read, that it is still
 * the authoritative provider through the registry's OPTIONAL non-resolving
 * identity predicate `isCurrent`. Absence latches
 * `provider-identity-unavailable`; a false result latches `custom-provider`.
 * Both latches are terminal: the observer detaches, the ring clears, and the
 * source answers `unsupported` forever after — a replacement provider's
 * decisions are never guessed from booleans.
 *
 * @module
 */
import { hasForbiddenAliasCharacter } from '@setu-ts/common';
import type {
  AuthorizationCoverage,
  AuthorizationDecisionObservation,
  AuthorizationDecisionOperation,
  AuthorizationDecisionReason,
  AuthorizationDecisionStep,
  AuthorizationDiagnosticsBatch,
  IAuthorizationDiagnosticsSource,
  IRuntimeServices,
  IServiceRegistry,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import type { RbacService } from '../services/rbac-service.ts';
import type {
  AuthorizationObserver,
  PermissionStepEval,
  RoleStepEval,
} from './authorization-observer.ts';
import { detachAuthorizationObserver } from './authorization-observer.ts';
import type { AuthorizationDiagnosticsOptions } from '../interfaces/index.ts';

/** Fixed bounds (not configurable). */
const MAX_APPROVED_RULES = 128;
const MAX_ALIAS_BYTES = 64;
const MAX_STEPS_PER_DECISION = 16;
const MAX_RETAINED_DECISIONS = 1_024;
const MAX_READ_LIMIT = 128;

/** Fixed, value-free construction and read errors. */
const COLLECTOR_ERRORS = {
  notEnabled: 'Authorization diagnostics: enabled must be the literal true.',
  badOptions: 'Authorization diagnostics: the authorizationDiagnostics option must be an object.',
  badRules:
    'Authorization diagnostics: roles and permissions must be objects of exact name to alias.',
  tooManyRules: 'Authorization diagnostics: more than 128 approved rules in one map.',
  aliasBytes: 'Authorization diagnostics: an alias must be 1 to 64 UTF-8 bytes.',
  aliasControl: 'Authorization diagnostics: an alias contains a control character.',
  duplicateAlias: 'Authorization diagnostics: an alias is not unique within its map.',
  badRevision:
    'Authorization diagnostics: policyRevision must be 1 to 64 UTF-8 bytes with no control character.',
  badInstanceId: 'Authorization diagnostics: read requires a non-empty instance identifier.',
  badCursor: 'Authorization diagnostics: after must be a non-negative safe integer.',
  badLimit: 'Authorization diagnostics: limit must be an integer from 1 to 128.',
  beyondSequence: 'Authorization diagnostics: after is beyond the retained sequence.',
} as const;

/** Recursively freezes a DTO so a reader holding it observes nothing after. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Advances a counter with saturation at `Number.MAX_SAFE_INTEGER`. */
function saturatingNext(current: number): number {
  return current >= Number.MAX_SAFE_INTEGER ? current : current + 1;
}

/** A plain object (not null, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The UTF-8 byte length of a string. */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * The compiled, validated authorization-observation policy.
 *
 * @internal
 */
export interface CompiledAuthorizationPolicy {
  readonly roleAlias: ReadonlyMap<string, string>;
  readonly permissionAlias: ReadonlyMap<string, string>;
  readonly policyRevision: string | null;
}

/** Validates one alias against M98d's shape rule. */
function assertAlias(alias: unknown, seen: Set<string>): string {
  if (typeof alias !== 'string' || alias.length === 0 || utf8ByteLength(alias) > MAX_ALIAS_BYTES) {
    throw new Error(COLLECTOR_ERRORS.aliasBytes);
  }
  if (hasForbiddenAliasCharacter(alias)) {
    throw new Error(COLLECTOR_ERRORS.aliasControl);
  }
  if (seen.has(alias)) {
    throw new Error(COLLECTOR_ERRORS.duplicateAlias);
  }
  seen.add(alias);
  return alias;
}

/** Compiles and validates one exact-name → alias map. */
function compileAliasMap(map: unknown): ReadonlyMap<string, string> {
  if (!isPlainObject(map)) {
    throw new Error(COLLECTOR_ERRORS.badRules);
  }
  const entries = Object.entries(map);
  if (entries.length > MAX_APPROVED_RULES) {
    throw new Error(COLLECTOR_ERRORS.tooManyRules);
  }
  const seen = new Set<string>();
  const compiled = new Map<string, string>();
  for (const [name, alias] of entries) {
    compiled.set(name, assertAlias(alias, seen));
  }
  return compiled;
}

/**
 * Validates the authorization-observation options at CONSTRUCTION and returns
 * the compiled policy. A malformed option — including `enabled: false` from a
 * caller the literal type cannot reach — refuses before any application
 * exists, with a fixed, value-free message.
 *
 * @param options - The caller's `authorizationDiagnostics` option
 * @returns The compiled policy
 * @internal
 */
export function compileAuthorizationDiagnosticsOptions(
  options: AuthorizationDiagnosticsOptions,
): CompiledAuthorizationPolicy {
  if (!isPlainObject(options)) {
    throw new Error(COLLECTOR_ERRORS.badOptions);
  }
  if (options.enabled !== true) {
    throw new Error(COLLECTOR_ERRORS.notEnabled);
  }
  const roleAlias = compileAliasMap(options.roles);
  const permissionAlias = compileAliasMap(options.permissions);
  let policyRevision: string | null = null;
  if (options.policyRevision !== undefined) {
    if (
      typeof options.policyRevision !== 'string' || options.policyRevision.length === 0 ||
      utf8ByteLength(options.policyRevision) > MAX_ALIAS_BYTES ||
      hasForbiddenAliasCharacter(options.policyRevision)
    ) {
      throw new Error(COLLECTOR_ERRORS.badRevision);
    }
    policyRevision = options.policyRevision;
  }
  return { roleAlias, permissionAlias, policyRevision };
}

/**
 * One retained decision, stored with its monotonic capture time. `read`
 * projects this into the public DTO, computing `ageMs` from `capturedAtMs`.
 *
 * @internal
 */
interface RetainedDecision {
  readonly sequence: number;
  readonly id: string;
  readonly operation: AuthorizationDecisionOperation;
  readonly result: boolean;
  readonly ruleAliases: readonly string[];
  readonly steps: readonly AuthorizationDecisionStep[];
  readonly stepsEvaluated: number;
  readonly stepsTruncated: boolean;
  readonly viaRoleAlias: string | null;
  readonly reason: AuthorizationDecisionReason;
  readonly capturedAtMs: number;
}

/**
 * The M98h authorization-observation collector and `IAuthorizationDiagnosticsSource`.
 *
 * @internal
 */
export class AuthorizationObservationCollector
  implements IAuthorizationDiagnosticsSource, AuthorizationObserver {
  readonly #policy: CompiledAuthorizationPolicy;
  readonly #clock: IRuntimeServices;
  readonly #registry: IServiceRegistry;
  readonly #rbac: RbacService;

  #decisions: RetainedDecision[] = [];
  #sequence = 0;
  #decisionCounter = 0;
  #droppedUnapproved = 0;
  #closed = false;
  #latched: AuthorizationCoverage | null = null;

  constructor(
    policy: CompiledAuthorizationPolicy,
    clock: IRuntimeServices,
    registry: IServiceRegistry,
    rbac: RbacService,
  ) {
    this.#policy = policy;
    this.#clock = clock;
    this.#registry = registry;
    this.#rbac = rbac;
  }

  // ---------------------------------------------------------------------------
  // Provider-identity verification
  // ---------------------------------------------------------------------------

  /**
   * Verifies the collector still owns the authoritative RBAC provider through
   * the registry's optional non-resolving identity predicate. Absence latches
   * `provider-identity-unavailable`; a false result latches `custom-provider`.
   * A latch is terminal: the observer detaches and the ring clears.
   */
  #checkProviderIdentity(): void {
    if (this.#latched !== null) {
      return;
    }
    const isCurrent = this.#registry.isCurrent;
    if (typeof isCurrent !== 'function') {
      this.#latch('provider-identity-unavailable');
      return;
    }
    if (!isCurrent.call(this.#registry, CAPABILITIES.AUTHORIZATION, this.#rbac)) {
      this.#latch('custom-provider');
    }
  }

  /** Latches the source as `unsupported`, detaches, and clears the ring. */
  #latch(coverage: AuthorizationCoverage): void {
    this.#latched = coverage;
    detachAuthorizationObserver(this.#rbac);
    this.#decisions.length = 0;
    this.#sequence = 0;
    this.#decisionCounter = 0;
    this.#droppedUnapproved = 0;
  }

  /** Increments the approval-drop counter (saturating). */
  #drop(): void {
    this.#droppedUnapproved = saturatingNext(this.#droppedUnapproved);
  }

  /** Buffers one fully-aliased decision, evicting the oldest past the bound. */
  #buffer(
    operation: AuthorizationDecisionOperation,
    ruleAliases: readonly string[],
    steps: readonly AuthorizationDecisionStep[],
    stepsEvaluated: number,
    stepsTruncated: boolean,
    result: boolean,
    reason: AuthorizationDecisionReason,
    viaRoleAlias: string | null,
  ): void {
    this.#sequence = saturatingNext(this.#sequence);
    this.#decisionCounter = saturatingNext(this.#decisionCounter);
    this.#decisions.push({
      sequence: this.#sequence,
      id: `d${this.#decisionCounter}`,
      operation,
      result,
      ruleAliases,
      steps,
      stepsEvaluated,
      stepsTruncated,
      viaRoleAlias,
      reason,
      capturedAtMs: this.#clock.hrtime(),
    });
    if (this.#decisions.length > MAX_RETAINED_DECISIONS) {
      this.#decisions.shift();
    }
  }

  // ---------------------------------------------------------------------------
  // AuthorizationObserver — the seam the RbacService invokes
  // ---------------------------------------------------------------------------

  onRole(
    role: string,
    result: boolean,
    reason: AuthorizationDecisionReason,
    viaRole: string | null,
  ): void {
    if (this.#closed || this.#latched !== null) {
      return;
    }
    this.#checkProviderIdentity();
    if (this.#latched !== null) {
      return;
    }
    const ruleAlias = this.#policy.roleAlias.get(role);
    if (ruleAlias === undefined) {
      this.#drop();
      return;
    }
    const viaRoleAlias = viaRole === null ? null : (this.#policy.roleAlias.get(viaRole) ?? null);
    const step: AuthorizationDecisionStep = viaRoleAlias === null
      ? { ruleAlias, reason }
      : { ruleAlias, reason, viaRoleAlias };
    this.#buffer('role', [ruleAlias], [step], 1, false, result, reason, viaRoleAlias);
  }

  onPermission(
    permission: string,
    result: boolean,
    reason: AuthorizationDecisionReason,
    viaRole: string | null,
  ): void {
    if (this.#closed || this.#latched !== null) {
      return;
    }
    this.#checkProviderIdentity();
    if (this.#latched !== null) {
      return;
    }
    const ruleAlias = this.#policy.permissionAlias.get(permission);
    if (ruleAlias === undefined) {
      this.#drop();
      return;
    }
    const viaRoleAlias = viaRole === null ? null : (this.#policy.roleAlias.get(viaRole) ?? null);
    const step: AuthorizationDecisionStep = viaRoleAlias === null
      ? { ruleAlias, reason }
      : { ruleAlias, reason, viaRoleAlias };
    this.#buffer('permission', [ruleAlias], [step], 1, false, result, reason, viaRoleAlias);
  }

  onAnyRole(
    requested: readonly string[],
    evaluated: readonly RoleStepEval[],
    evaluatedCount: number,
    result: boolean,
  ): void {
    if (this.#closed || this.#latched !== null) {
      return;
    }
    this.#checkProviderIdentity();
    if (this.#latched !== null) {
      return;
    }
    // The DISTINCT requested rules, in first-requested order. Aliases are
    // unique within a map of at most 128 entries, so the list can never
    // exceed the wire's 128-alias bound however many duplicates the caller
    // passed — a duplicated request must not poison every later read.
    const ruleAliases: string[] = [];
    const seen = new Set<string>();
    for (const role of requested) {
      const alias = this.#policy.roleAlias.get(role);
      if (alias === undefined) {
        this.#drop();
        return;
      }
      if (!seen.has(alias)) {
        seen.add(alias);
        ruleAliases.push(alias);
      }
    }
    const steps: AuthorizationDecisionStep[] = [];
    for (const step of evaluated) {
      if (steps.length === MAX_STEPS_PER_DECISION) {
        break;
      }
      const ruleAlias = this.#policy.roleAlias.get(step.role)!;
      const viaRoleAlias = step.viaRole === null
        ? null
        : (this.#policy.roleAlias.get(step.viaRole) ?? null);
      const aliased: AuthorizationDecisionStep = viaRoleAlias === null
        ? { ruleAlias, reason: step.reason }
        : { ruleAlias, reason: step.reason, viaRoleAlias };
      steps.push(aliased);
    }
    const reason: AuthorizationDecisionReason = result
      ? 'compound-satisfied'
      : 'compound-unsatisfied';
    this.#buffer(
      'any-role',
      ruleAliases,
      steps,
      evaluatedCount,
      evaluatedCount > MAX_STEPS_PER_DECISION,
      result,
      reason,
      null,
    );
  }

  onAllPermissions(
    requested: readonly string[],
    evaluated: readonly PermissionStepEval[],
    evaluatedCount: number,
    result: boolean,
  ): void {
    if (this.#closed || this.#latched !== null) {
      return;
    }
    this.#checkProviderIdentity();
    if (this.#latched !== null) {
      return;
    }
    // The DISTINCT requested rules, in first-requested order. Aliases are
    // unique within a map of at most 128 entries, so the list can never
    // exceed the wire's 128-alias bound however many duplicates the caller
    // passed — a duplicated request must not poison every later read.
    const ruleAliases: string[] = [];
    const seen = new Set<string>();
    for (const permission of requested) {
      const alias = this.#policy.permissionAlias.get(permission);
      if (alias === undefined) {
        this.#drop();
        return;
      }
      if (!seen.has(alias)) {
        seen.add(alias);
        ruleAliases.push(alias);
      }
    }
    const steps: AuthorizationDecisionStep[] = [];
    for (const step of evaluated) {
      if (steps.length === MAX_STEPS_PER_DECISION) {
        break;
      }
      const ruleAlias = this.#policy.permissionAlias.get(step.permission)!;
      const viaRoleAlias = step.viaRole === null
        ? null
        : (this.#policy.roleAlias.get(step.viaRole) ?? null);
      const aliased: AuthorizationDecisionStep = viaRoleAlias === null
        ? { ruleAlias, reason: step.reason }
        : { ruleAlias, reason: step.reason, viaRoleAlias };
      steps.push(aliased);
    }
    const reason: AuthorizationDecisionReason = result
      ? 'compound-satisfied'
      : 'compound-unsatisfied';
    this.#buffer(
      'all-permissions',
      ruleAliases,
      steps,
      evaluatedCount,
      evaluatedCount > MAX_STEPS_PER_DECISION,
      result,
      reason,
      null,
    );
  }

  // ---------------------------------------------------------------------------
  // IAuthorizationDiagnosticsSource
  // ---------------------------------------------------------------------------

  /**
   * {@inheritDoc IAuthorizationDiagnosticsSource.read}
   *
   * Follows the M98a cursor contract exactly: `after` is exclusive, a cursor
   * parked behind an eviction receives the oldest retained decisions with the
   * skipped sequences reported as `lost`, `after: 0` is not special-cased, and
   * a closed source answers an empty closed batch for every cursor it issued
   * and refuses one beyond its sequence, exactly as while running.
   */
  read(instanceId: string, after: number, limit?: number): AuthorizationDiagnosticsBatch {
    if (typeof instanceId !== 'string' || instanceId === '') {
      throw new RangeError(COLLECTOR_ERRORS.badInstanceId);
    }
    const effectiveLimit = limit === undefined ? MAX_READ_LIMIT : limit;
    if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) {
      throw new RangeError(COLLECTOR_ERRORS.badCursor);
    }
    if (
      typeof effectiveLimit !== 'number' || !Number.isInteger(effectiveLimit) ||
      effectiveLimit < 1 || effectiveLimit > MAX_READ_LIMIT
    ) {
      throw new RangeError(COLLECTOR_ERRORS.badLimit);
    }
    // Re-verify the provider identity before every read.
    this.#checkProviderIdentity();
    if (this.#latched !== null) {
      return deepFreeze({
        version: 1 as const,
        instanceId,
        state: 'unsupported' as const,
        coverage: this.#latched,
        decisions: Object.freeze([]),
        next: after,
        lost: 0,
        closed: this.#closed,
        droppedUnapproved: this.#droppedUnapproved,
      });
    }
    // Close never rewinds the sequence, so every cursor this source could
    // have issued is still at or below it: a closed source applies the same
    // refusal as a running one (the #372 fix to the kernel, queue and trace
    // readers).
    if (after > this.#sequence) {
      throw new RangeError(COLLECTOR_ERRORS.beyondSequence);
    }
    if (this.#closed) {
      return deepFreeze({
        version: 1 as const,
        instanceId,
        state: 'no-data' as const,
        decisions: Object.freeze([]),
        next: after,
        lost: 0,
        closed: true,
        droppedUnapproved: this.#droppedUnapproved,
      });
    }
    const now = this.#clock.hrtime();
    const first = this.#decisions.length > 0 ? this.#decisions[0].sequence : this.#sequence + 1;
    const start = Math.max(after + 1, first);
    const decisions: AuthorizationDecisionObservation[] = [];
    for (const retained of this.#decisions) {
      if (retained.sequence < start) {
        continue;
      }
      if (decisions.length === effectiveLimit) {
        break;
      }
      decisions.push(this.#project(retained, now));
    }
    return deepFreeze({
      version: 1 as const,
      instanceId,
      state: this.#sequence === 0 ? ('no-data' as const) : ('ready' as const),
      decisions: Object.freeze(decisions),
      next: decisions.length > 0 ? decisions[decisions.length - 1]!.sequence : after,
      lost: decisions.length > 0 ? start - after - 1 : 0,
      closed: false,
      droppedUnapproved: this.#droppedUnapproved,
    });
  }

  /** Projects one retained decision into the public DTO. */
  #project(retained: RetainedDecision, now: number): AuthorizationDecisionObservation {
    const steps: readonly AuthorizationDecisionStep[] = retained.steps.map((step) =>
      step.viaRoleAlias !== undefined
        ? { ruleAlias: step.ruleAlias, reason: step.reason, viaRoleAlias: step.viaRoleAlias }
        : { ruleAlias: step.ruleAlias, reason: step.reason }
    );
    return {
      sequence: retained.sequence,
      id: retained.id,
      operation: retained.operation,
      result: retained.result,
      ruleAliases: [...retained.ruleAliases],
      steps,
      stepsEvaluated: retained.stepsEvaluated,
      stepsTruncated: retained.stepsTruncated,
      ...(retained.viaRoleAlias !== null ? { viaRoleAlias: retained.viaRoleAlias } : {}),
      reason: retained.reason,
      ...(this.#policy.policyRevision !== null
        ? { policyRevision: this.#policy.policyRevision }
        : {}),
      ageMs: now - retained.capturedAtMs,
    };
  }

  /** Detaches the observer, clears the ring, and marks the source closed. */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    detachAuthorizationObserver(this.#rbac);
    this.#decisions.length = 0;
  }
}

/**
 * The inert, disabled authorization-diagnostics source (M98h). Registered when
 * the plugin's `authorizationDiagnostics` option is absent: it reports
 * `disabled` and performs no capture. It still validates the instance
 * argument with the same fixed, value-free error as the active source, so a
 * connector never sees a differently-shaped failure for the disabled path.
 *
 * @internal
 */
export function createDisabledAuthorizationSource(): IAuthorizationDiagnosticsSource {
  return {
    read(instanceId: string, after: number, limit?: number): AuthorizationDiagnosticsBatch {
      if (typeof instanceId !== 'string' || instanceId === '') {
        throw new RangeError(COLLECTOR_ERRORS.badInstanceId);
      }
      const effectiveLimit = limit === undefined ? MAX_READ_LIMIT : limit;
      if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) {
        throw new RangeError(COLLECTOR_ERRORS.badCursor);
      }
      if (
        typeof effectiveLimit !== 'number' || !Number.isInteger(effectiveLimit) ||
        effectiveLimit < 1 || effectiveLimit > MAX_READ_LIMIT
      ) {
        throw new RangeError(COLLECTOR_ERRORS.badLimit);
      }
      return Object.freeze({
        version: 1,
        instanceId,
        state: 'disabled',
        decisions: Object.freeze([]),
        next: after,
        lost: 0,
        closed: false,
        droppedUnapproved: 0,
      });
    },
  };
}

/**
 * The unsupported authorization-diagnostics source (M98h). Registered when the
 * option is present but no RBAC was configured: it reports `unsupported` with
 * the fixed coverage reason and performs no capture.
 *
 * @internal
 */
export function createUnsupportedAuthorizationSource(
  coverage: AuthorizationCoverage,
): IAuthorizationDiagnosticsSource {
  return {
    read(instanceId: string, after: number, limit?: number): AuthorizationDiagnosticsBatch {
      if (typeof instanceId !== 'string' || instanceId === '') {
        throw new RangeError(COLLECTOR_ERRORS.badInstanceId);
      }
      const effectiveLimit = limit === undefined ? MAX_READ_LIMIT : limit;
      if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) {
        throw new RangeError(COLLECTOR_ERRORS.badCursor);
      }
      if (
        typeof effectiveLimit !== 'number' || !Number.isInteger(effectiveLimit) ||
        effectiveLimit < 1 || effectiveLimit > MAX_READ_LIMIT
      ) {
        throw new RangeError(COLLECTOR_ERRORS.badLimit);
      }
      return Object.freeze({
        version: 1,
        instanceId,
        state: 'unsupported',
        coverage,
        decisions: Object.freeze([]),
        next: after,
        lost: 0,
        closed: false,
        droppedUnapproved: 0,
      });
    },
  };
}
