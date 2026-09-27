/**
 * Authorization observation protocol (M98h): the exact validation of an
 * authorization source's batch before the connector signs it, the
 * field-by-field projection of that batch, and the ONE validator both sides
 * of the wire run over it.
 *
 * An authorization source is a registered capability, so its batch is
 * untrusted input to the connector: every field is read once, checked against
 * its fixed vocabulary or bound, and copied — never spread — so an unexpected
 * field, a throwing getter, an oversized alias, or a control character cannot
 * reach the signed frame. Aliases must match the display shape (1–64 UTF-8
 * bytes, no control character) and decision ids the `d<N>` grammar.
 *
 * @module
 */

import type {
  AuthorizationCoverage,
  AuthorizationDecisionOperation,
  AuthorizationDecisionReason,
  AuthorizationDiagnosticsBatch,
  AuthorizationSourceState,
} from '@setu-ts/common';

import { hasExactKeys, isDisplayAlias, isRecord } from './protocol.ts';

/** The per-read decision bound a source honours, and so a source batch's ceiling. */
const MAX_AUTHORIZATION_DECISIONS = 128;

/** The evaluated-step budget per decision — the same fixed sixteen the collector enforces. */
const MAX_AUTHORIZATION_STEPS = 16;

/**
 * The complete requested-rule set a decision carries. `ruleAliases` is the
 * COMPLETE set of DISTINCT requested rules (plan §3.3: every one approved, or
 * the whole decision was dropped). The collector de-duplicates it, and
 * aliases are unique within a map of at most 128 entries, so it is bounded by
 * that approved-map ceiling however many duplicates a caller passed — NOT by
 * the 16-step retention budget, which bounds `steps` only. A truncated
 * compound over 16 requested rules must pass the wire with its full alias
 * list and `stepsTruncated: true`, not be refused wholesale.
 */
const MAX_AUTHORIZATION_RULE_ALIASES = 128;

const SOURCE_STATES: ReadonlySet<string> = new Set<AuthorizationSourceState>([
  'disabled',
  'no-data',
  'ready',
  'unsupported',
  'collection-failed',
]);
const COVERAGE: ReadonlySet<string> = new Set<AuthorizationCoverage>([
  'rbac-not-configured',
  'provider-identity-unavailable',
  'custom-provider',
  'unknown',
]);
const OPERATIONS: ReadonlySet<string> = new Set<AuthorizationDecisionOperation>([
  'role',
  'permission',
  'any-role',
  'all-permissions',
]);
const REASONS: ReadonlySet<string> = new Set<AuthorizationDecisionReason>([
  'direct-role',
  'inherited-role',
  'direct-permission',
  'direct-wildcard',
  'role-permission',
  'role-wildcard',
  'not-held',
  'compound-satisfied',
  'compound-unsatisfied',
]);

/** The opaque per-source decision-id grammar: `d` followed by a decimal from 1. */
const DECISION_ID_PATTERN = /^d[1-9][0-9]*$/;

/** A valid opaque decision id. */
function isDecisionId(value: unknown): value is string {
  return typeof value === 'string' && DECISION_ID_PATTERN.test(value);
}

/** A non-negative safe integer. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A finite, non-negative millisecond measurement. */
function isMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Copies a source-supplied list INDEX BY INDEX, reading its `length` once
 * and never more than `max + 1` items — never through the source's own
 * iterator, `map` or `toJSON`. An `Array` subclass (or a `Proxy` over one)
 * can report one `length` while its iterator yields any number of items,
 * including infinitely many; iterating it would let a replacement source
 * exceed the requested limit or hang the connector's event loop. Reading one
 * item past the budget is what lets the caller refuse an over-budget list
 * rather than silently truncate it (the M98e re-audit precedent).
 *
 * @param value - The candidate list
 * @param max - The budget
 * @returns The copied items (at most `max + 1`), or `null` for a non-array
 */
function copyBounded(value: unknown, max: number): unknown[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const length = Math.min(value.length, max + 1);
  const copy: unknown[] = [];
  for (let index = 0; index < length; index++) {
    copy.push(value[index]);
  }
  return copy;
}

/**
 * The step-count invariants of one decision. A single check (`role` /
 * `permission`) names exactly one rule and evaluated exactly one step. A
 * compound may name NO rule — `hasAnyRole(principal, [])` is a real,
 * unsatisfied decision with zero steps, and refusing it would turn every
 * later read into `collection-failed`. A compound's evaluated count is NOT
 * bounded by its distinct rule count: a request repeating a rule evaluates it
 * once per occurrence. It retains
 * `min(evaluated, 16)` of them, and is `stepsTruncated` EXACTLY when it
 * evaluated more than 16 — so a partial step list can never be presented as
 * the complete explanation, and a complete one never claims truncation.
 *
 * @param operation - The validated operation
 * @param ruleCount - The number of requested rule aliases
 * @param stepCount - The number of retained steps
 * @param stepsEvaluated - The claimed evaluated count
 * @param stepsTruncated - The claimed truncation flag
 * @returns `true` when the counts are mutually consistent
 */
function isConsistentStepCount(
  operation: string,
  ruleCount: number,
  stepCount: number,
  stepsEvaluated: number,
  stepsTruncated: boolean,
): boolean {
  if (operation === 'role' || operation === 'permission') {
    return ruleCount === 1 && stepCount === 1 && stepsEvaluated === 1 && !stepsTruncated;
  }
  return (ruleCount > 0 || stepsEvaluated === 0) &&
    stepCount === Math.min(stepsEvaluated, MAX_AUTHORIZATION_STEPS) &&
    stepsTruncated === (stepsEvaluated > MAX_AUTHORIZATION_STEPS);
}

/** Membership in a fixed vocabulary. */
function isOneOf(value: unknown, vocabulary: ReadonlySet<string>): value is string {
  return typeof value === 'string' && vocabulary.has(value);
}

/**
 * One validated authorization decision step, copied field by field.
 *
 * @internal
 */
export interface ValidatedAuthorizationStep {
  readonly ruleAlias: string;
  readonly reason: AuthorizationDecisionReason;
  readonly viaRoleAlias: string | null;
}

/**
 * One validated authorization decision, copied field by field.
 *
 * @internal
 */
export interface ValidatedAuthorizationDecision {
  readonly sequence: number;
  readonly id: string;
  readonly operation: AuthorizationDecisionOperation;
  readonly result: boolean;
  readonly ruleAliases: readonly string[];
  readonly steps: readonly ValidatedAuthorizationStep[];
  readonly stepsEvaluated: number;
  readonly stepsTruncated: boolean;
  readonly viaRoleAlias: string | null;
  readonly reason: AuthorizationDecisionReason;
  readonly policyRevision: string | null;
  readonly ageMs: number;
}

/**
 * One validated source batch, copied field by field.
 *
 * @internal
 */
export interface ValidatedAuthorizationBatch {
  readonly state: AuthorizationSourceState;
  readonly coverage: AuthorizationCoverage | null;
  readonly decisions: readonly ValidatedAuthorizationDecision[];
  readonly next: number;
  readonly lost: number;
  readonly closed: boolean;
  readonly droppedUnapproved: number;
}

const BATCH_KEYS: readonly string[] = [
  'version',
  'instanceId',
  'state',
  'decisions',
  'next',
  'lost',
  'closed',
  'droppedUnapproved',
];
const DECISION_KEYS: readonly string[] = [
  'sequence',
  'id',
  'operation',
  'result',
  'ruleAliases',
  'steps',
  'stepsEvaluated',
  'stepsTruncated',
  'reason',
  'ageMs',
];
const STEP_KEYS: readonly string[] = ['ruleAlias', 'reason'];

/** Validates and copies one decision step. */
function readStep(value: unknown): ValidatedAuthorizationStep | null {
  if (!isRecord(value)) {
    return null;
  }
  const hasVia = Object.hasOwn(value, 'viaRoleAlias');
  if (!hasExactKeys(value, hasVia ? [...STEP_KEYS, 'viaRoleAlias'] : STEP_KEYS)) {
    return null;
  }
  const ruleAlias = value.ruleAlias;
  const reason = value.reason;
  const viaRoleAlias = value.viaRoleAlias;
  if (
    !isDisplayAlias(ruleAlias) || !isOneOf(reason, REASONS) ||
    (hasVia && !isDisplayAlias(viaRoleAlias))
  ) {
    return null;
  }
  return {
    ruleAlias,
    reason: reason as AuthorizationDecisionReason,
    viaRoleAlias: hasVia ? (viaRoleAlias as string) : null,
  };
}

/**
 * Validates and copies one decision. Every field is read EXACTLY once into a
 * local, validated there, and the copy is built from those locals — a getter
 * that answers differently on a second read never reaches the copy.
 */
function readDecision(value: unknown): ValidatedAuthorizationDecision | null {
  if (!isRecord(value)) {
    return null;
  }
  const hasVia = Object.hasOwn(value, 'viaRoleAlias');
  const hasRevision = Object.hasOwn(value, 'policyRevision');
  const keys = [
    ...DECISION_KEYS,
    ...(hasVia ? ['viaRoleAlias'] : []),
    ...(hasRevision ? ['policyRevision'] : []),
  ];
  if (!hasExactKeys(value, keys)) {
    return null;
  }
  const operation = value.operation;
  const reason = value.reason;
  const result = value.result;
  if (
    !isOneOf(operation, OPERATIONS) || !isOneOf(reason, REASONS) ||
    typeof result !== 'boolean'
  ) {
    return null;
  }
  const rawRuleAliases = copyBounded(value.ruleAliases, MAX_AUTHORIZATION_RULE_ALIASES);
  if (
    rawRuleAliases === null ||
    rawRuleAliases.length > MAX_AUTHORIZATION_RULE_ALIASES ||
    !rawRuleAliases.every(isDisplayAlias)
  ) {
    return null;
  }
  const rawSteps = copyBounded(value.steps, MAX_AUTHORIZATION_STEPS);
  if (
    rawSteps === null ||
    rawSteps.length > MAX_AUTHORIZATION_STEPS
  ) {
    return null;
  }
  const steps: ValidatedAuthorizationStep[] = [];
  for (const raw of rawSteps) {
    const step = readStep(raw);
    if (step === null) {
      return null;
    }
    steps.push(step);
  }
  const {
    sequence,
    id,
    stepsEvaluated,
    stepsTruncated,
    ageMs,
  } = value;
  const viaRoleAlias = value.viaRoleAlias;
  const policyRevision = value.policyRevision;
  if (
    !isCount(sequence) || sequence < 1 || !isDecisionId(id) ||
    !isCount(stepsEvaluated) || typeof stepsTruncated !== 'boolean' ||
    !isMs(ageMs) || (hasVia && !isDisplayAlias(viaRoleAlias)) ||
    (hasRevision && !isDisplayAlias(policyRevision))
  ) {
    return null;
  }
  if (
    !isConsistentStepCount(
      operation,
      rawRuleAliases.length,
      steps.length,
      stepsEvaluated,
      stepsTruncated,
    )
  ) {
    return null;
  }
  return {
    sequence,
    id,
    operation: operation as AuthorizationDecisionOperation,
    result,
    ruleAliases: rawRuleAliases as string[],
    steps,
    stepsEvaluated,
    stepsTruncated,
    viaRoleAlias: hasVia ? (viaRoleAlias as string) : null,
    reason: reason as AuthorizationDecisionReason,
    policyRevision: hasRevision ? (policyRevision as string) : null,
    ageMs,
  };
}

/**
 * Validates an untrusted authorization source batch against the exact M98h
 * DTO and the M98a cursor contract for the cursor the connector requested,
 * and returns a field-by-field copy.
 *
 * Refused: any unknown, missing or extra key; a value outside its fixed
 * vocabulary or bound; an alias outside the display shape; a decision id
 * outside the `d<N>` grammar; a `disabled` or `unsupported` batch carrying any
 * decision; a closed batch carrying any decision; more decisions than the
 * requested limit; sequences not strictly increasing past the cursor; a
 * `coverage` present on a non-`unsupported` state or absent on an
 * `unsupported` one; and a `next`/`lost` pair disagreeing with the returned
 * decisions. Any throw while reading — a hostile getter — is a refusal too.
 *
 * @param value - The batch the source returned
 * @param instanceId - The instance UUID the connector requested
 * @param cursor - The exclusive cursor the connector requested
 * @param limit - The decision bound the connector requested
 * @returns The validated copy, or `null` for any violation
 * @internal
 */
export function readAuthorizationSourceBatch(
  value: unknown,
  instanceId: string,
  cursor: number,
  limit: number,
): ValidatedAuthorizationBatch | null {
  try {
    if (!isRecord(value) || value.version !== 1) {
      return null;
    }
    if (value.instanceId !== instanceId) {
      return null;
    }
    const state = value.state;
    if (!isOneOf(state, SOURCE_STATES)) {
      return null;
    }
    // `coverage` is present exactly when the state is `unsupported`.
    const hasCoverage = Object.hasOwn(value, 'coverage');
    if ((state === 'unsupported') !== hasCoverage) {
      return null;
    }
    const batchKeys = hasCoverage ? [...BATCH_KEYS, 'coverage'] : BATCH_KEYS;
    if (!hasExactKeys(value, batchKeys)) {
      return null;
    }
    const coverage = hasCoverage ? value.coverage : null;
    if (hasCoverage && !isOneOf(coverage, COVERAGE)) {
      return null;
    }
    const { next, lost, closed, droppedUnapproved } = value;
    const rawDecisions = copyBounded(value.decisions, limit);
    if (
      rawDecisions === null || rawDecisions.length > limit ||
      !isCount(next) || !isCount(lost) || typeof closed !== 'boolean' ||
      !isCount(droppedUnapproved)
    ) {
      return null;
    }
    // A source that observes nothing retains nothing: `disabled` and
    // `unsupported` observe by definition, and a closed source has cleared
    // its ring.
    if (
      (state === 'disabled' || state === 'unsupported' || closed) && rawDecisions.length > 0
    ) {
      return null;
    }
    const decisions: ValidatedAuthorizationDecision[] = [];
    let previous = cursor;
    for (const raw of rawDecisions) {
      const decision = readDecision(raw);
      if (decision === null || decision.sequence <= previous) {
        return null;
      }
      previous = decision.sequence;
      decisions.push(decision);
    }
    const expectedNext = decisions.length > 0 ? decisions[decisions.length - 1]!.sequence : cursor;
    const expectedLost = decisions.length > 0 ? decisions[0]!.sequence - cursor - 1 : 0;
    if (next !== expectedNext || lost !== expectedLost) {
      return null;
    }
    return {
      state: state as AuthorizationSourceState,
      coverage: coverage as AuthorizationCoverage | null,
      decisions,
      next,
      lost,
      closed,
      droppedUnapproved,
    };
  } catch {
    return null;
  }
}

/** Copies one validated step field by field. */
function projectStep(step: ValidatedAuthorizationStep): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    ruleAlias: step.ruleAlias,
    reason: step.reason,
  };
  if (step.viaRoleAlias !== null) {
    projected.viaRoleAlias = step.viaRoleAlias;
  }
  return projected;
}

/** Copies one validated decision field by field. */
function projectDecision(decision: ValidatedAuthorizationDecision): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    sequence: decision.sequence,
    id: decision.id,
    operation: decision.operation,
    result: decision.result,
    ruleAliases: [...decision.ruleAliases],
    steps: decision.steps.map(projectStep),
    stepsEvaluated: decision.stepsEvaluated,
    stepsTruncated: decision.stepsTruncated,
    reason: decision.reason,
    ageMs: decision.ageMs,
  };
  if (decision.viaRoleAlias !== null) {
    projected.viaRoleAlias = decision.viaRoleAlias;
  }
  if (decision.policyRevision !== null) {
    projected.policyRevision = decision.policyRevision;
  }
  return projected;
}

/**
 * Projects a validated authorization batch into the serialization-ready
 * record — the compact final JSON, not an envelope.
 *
 * @param batch - The validated batch
 * @param instanceId - The bound instance UUID the batch was read for
 * @returns The projected, serialization-ready record
 * @internal
 */
export function projectAuthorizationBatch(
  batch: ValidatedAuthorizationBatch,
  instanceId: string,
): Record<string, unknown> {
  return {
    version: 1,
    instanceId,
    state: batch.state,
    ...(batch.coverage !== null ? { coverage: batch.coverage } : {}),
    decisions: batch.decisions.map(projectDecision),
    next: batch.next,
    lost: batch.lost,
    closed: batch.closed,
    droppedUnapproved: batch.droppedUnapproved,
  };
}

const PROJECTION_KEYS: readonly string[] = [
  'version',
  'instanceId',
  'state',
  'decisions',
  'next',
  'lost',
  'closed',
  'droppedUnapproved',
];
const PROJECTION_DECISION_KEYS: readonly string[] = [
  'sequence',
  'id',
  'operation',
  'result',
  'ruleAliases',
  'steps',
  'stepsEvaluated',
  'stepsTruncated',
  'reason',
  'ageMs',
];
const PROJECTION_STEP_KEYS: readonly string[] = ['ruleAlias', 'reason'];

/** Validates one projected step against the exact M98h DTO. */
function isStepProjection(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const hasVia = Object.hasOwn(value, 'viaRoleAlias');
  return hasExactKeys(
    value,
    hasVia ? [...PROJECTION_STEP_KEYS, 'viaRoleAlias'] : PROJECTION_STEP_KEYS,
  ) &&
    isDisplayAlias(value.ruleAlias) && isOneOf(value.reason, REASONS) &&
    (!hasVia || isDisplayAlias(value.viaRoleAlias));
}

/** Validates one projected decision against the exact M98h DTO. */
function isDecisionProjection(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const hasVia = Object.hasOwn(value, 'viaRoleAlias');
  const hasRevision = Object.hasOwn(value, 'policyRevision');
  const keys = [
    ...PROJECTION_DECISION_KEYS,
    ...(hasVia ? ['viaRoleAlias'] : []),
    ...(hasRevision ? ['policyRevision'] : []),
  ];
  if (!hasExactKeys(value, keys)) {
    return false;
  }
  const operation = value.operation;
  const reason = value.reason;
  if (
    !isOneOf(operation, OPERATIONS) || !isOneOf(reason, REASONS) ||
    typeof value.result !== 'boolean' || !isDecisionId(value.id)
  ) {
    return false;
  }
  const ruleAliases = value.ruleAliases;
  if (
    !Array.isArray(ruleAliases) ||
    ruleAliases.length > MAX_AUTHORIZATION_RULE_ALIASES ||
    !ruleAliases.every(isDisplayAlias)
  ) {
    return false;
  }
  const steps = value.steps;
  if (
    !Array.isArray(steps) || steps.length > MAX_AUTHORIZATION_STEPS ||
    !steps.every(isStepProjection)
  ) {
    return false;
  }
  const { sequence, stepsEvaluated, stepsTruncated, ageMs } = value;
  const viaRoleAlias = value.viaRoleAlias;
  const policyRevision = value.policyRevision;
  if (
    !isCount(sequence) || sequence < 1 || !isCount(stepsEvaluated) ||
    typeof stepsTruncated !== 'boolean' || !isMs(ageMs) ||
    (hasVia && !isDisplayAlias(viaRoleAlias)) || (hasRevision && !isDisplayAlias(policyRevision))
  ) {
    return false;
  }
  return isConsistentStepCount(
    operation,
    ruleAliases.length,
    steps.length,
    stepsEvaluated,
    stepsTruncated,
  );
}

/**
 * Reports whether a value is a well-formed M98h authorization-batch
 * projection: EXACTLY the batch keys, version `1`, a non-empty instance
 * string, a fixed state (with `coverage` present exactly when
 * `unsupported`), at most 128 decisions with strictly increasing sequences,
 * and every field from its fixed vocabulary or bound.
 *
 * ONE validator for both sides of the wire: the connector runs it over its
 * own projection before signing, and the native client runs it again before
 * handing data to a consumer.
 *
 * @param value - The parsed JSON value, or a fresh projection
 * @returns `true` when the value is a well-formed authorization batch
 * @internal
 */
export function isAuthorizationBatchProjection(
  value: unknown,
): value is AuthorizationDiagnosticsBatch {
  if (!isRecord(value)) {
    return false;
  }
  const decisions = value.decisions;
  const state = value.state;
  const hasCoverage = Object.hasOwn(value, 'coverage');
  const projectionKeys = hasCoverage ? [...PROJECTION_KEYS, 'coverage'] : PROJECTION_KEYS;
  if (
    !hasExactKeys(value, projectionKeys) ||
    value.version !== 1 || typeof value.instanceId !== 'string' ||
    value.instanceId.length === 0 ||
    !isOneOf(state, SOURCE_STATES) ||
    (state === 'unsupported') !== hasCoverage ||
    (hasCoverage && !isOneOf(value.coverage, COVERAGE)) ||
    !Array.isArray(decisions) || decisions.length > MAX_AUTHORIZATION_DECISIONS ||
    !isCount(value.next) || !isCount(value.lost) ||
    typeof value.closed !== 'boolean' || !isCount(value.droppedUnapproved)
  ) {
    return false;
  }
  if (!decisions.every(isDecisionProjection)) {
    return false;
  }
  for (let index = 1; index < decisions.length; index++) {
    if (
      (decisions[index] as { sequence: number }).sequence <=
        (decisions[index - 1] as { sequence: number }).sequence
    ) {
      return false;
    }
  }
  if (decisions.length > 0) {
    const last = (decisions[decisions.length - 1] as { sequence: number }).sequence;
    if (value.next !== last) {
      return false;
    }
  }
  return true;
}
