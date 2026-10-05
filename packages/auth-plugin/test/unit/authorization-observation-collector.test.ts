import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPrincipal, IRuntimeServices, IServiceRegistry } from '@setu-ts/common';
import {
  AuthorizationObservationCollector,
  compileAuthorizationDiagnosticsOptions,
} from '../../src/diagnostics/authorization-observation-collector.ts';
import {
  attachAuthorizationObserver,
  authorizationObserverOf,
} from '../../src/diagnostics/authorization-observer.ts';
import { RbacService } from '../../src/services/rbac-service.ts';

/** A deterministic clock whose time can be advanced by the test. */
function makeClock(): {
  clock: IRuntimeServices;
  now: () => number;
  advance: (ms: number) => void;
} {
  let time = 1_000;
  const clock = { hrtime: () => time } as unknown as IRuntimeServices;
  return {
    clock,
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

/** A minimal registry fake that reports a controllable `isCurrent` answer. */
function makeRegistry(answer: boolean | 'absent'): IServiceRegistry {
  const registry: Partial<IServiceRegistry> = {};
  if (answer !== 'absent') {
    (registry as Record<string, unknown>).isCurrent = (_token: unknown, _instance: unknown) =>
      answer;
  }
  return registry as unknown as IServiceRegistry;
}

const RBAC_CONFIG = {
  roles: {
    admin: { permissions: ['posts.read', 'posts.write'], inherits: ['editor'] },
    editor: { permissions: ['posts.read'] },
  },
};

function makeCollector(registry: IServiceRegistry = makeRegistry(true)) {
  const clock = makeClock();
  const rbac = new RbacService(RBAC_CONFIG);
  const policy = compileAuthorizationDiagnosticsOptions({
    enabled: true,
    roles: { admin: 'A', editor: 'E' },
    permissions: { 'posts.read': 'R', 'posts.write': 'W' },
    policyRevision: 'rev-1',
  });
  const collector = new AuthorizationObservationCollector(policy, clock.clock, registry, rbac);
  return { collector, clock, rbac };
}

const admin: IPrincipal = { id: 'p1', roles: ['admin'] };
const nobody: IPrincipal = { id: 'p2', roles: [] };

describe('compileAuthorizationDiagnosticsOptions (M98h)', () => {
  it('refuses a non-object option', () => {
    expect(() => compileAuthorizationDiagnosticsOptions(undefined as never)).toThrow(
      'must be an object',
    );
  });

  it('refuses enabled that is not the literal true', () => {
    expect(() =>
      compileAuthorizationDiagnosticsOptions({
        enabled: false,
        roles: {},
        permissions: {},
      } as never)
    ).toThrow('literal true');
  });

  it('refuses more than 128 rules in one map', () => {
    const roles: Record<string, string> = {};
    for (let index = 0; index < 129; index++) {
      roles[`role-${index}`] = `a${index}`;
    }
    expect(() =>
      compileAuthorizationDiagnosticsOptions({
        enabled: true,
        roles,
        permissions: {},
      })
    ).toThrow('more than 128');
  });

  it('refuses an alias outside 1 to 64 UTF-8 bytes', () => {
    expect(() =>
      compileAuthorizationDiagnosticsOptions({
        enabled: true,
        roles: { admin: '' },
        permissions: {},
      })
    ).toThrow('1 to 64');
    expect(() =>
      compileAuthorizationDiagnosticsOptions({
        enabled: true,
        roles: { admin: 'x'.repeat(65) },
        permissions: {},
      })
    ).toThrow('1 to 64');
  });

  it('refuses an alias with a control character', () => {
    expect(() =>
      compileAuthorizationDiagnosticsOptions({
        enabled: true,
        roles: { admin: 'a\u202eb' },
        permissions: {},
      })
    ).toThrow('control, format or line-separator character');
  });

  it('refuses a duplicate alias within a map', () => {
    expect(() =>
      compileAuthorizationDiagnosticsOptions({
        enabled: true,
        roles: { admin: 'A', editor: 'A' },
        permissions: {},
      })
    ).toThrow('not unique');
  });

  it('refuses a policyRevision outside the display shape', () => {
    expect(() =>
      compileAuthorizationDiagnosticsOptions({
        enabled: true,
        roles: {},
        permissions: {},
        policyRevision: '',
      })
    ).toThrow('policyRevision');
  });
});

describe('AuthorizationObservationCollector (M98h)', () => {
  it('de-duplicates a repeated request so its alias list never exceeds the approved ceiling', () => {
    // Round-3 Finding #2: 129 copies of one approved rule used to produce a
    // 129-alias list the wire refuses, turning every later read into
    // collection-failed.
    const { collector, rbac } = makeCollector();
    attachAuthorizationObserver(rbac, collector);
    expect(rbac.hasAnyRole(nobody, Array.from({ length: 129 }, () => 'admin'))).toBe(false);
    expect(
      rbac.hasAllPermissions(admin, [
        ...Array.from({ length: 130 }, () => 'posts.read'),
        'posts.write',
        'posts.read',
      ]),
    ).toBe(true);
    const [anyRole, allPermissions] = collector.read('instance', 0).decisions;
    expect(anyRole!.ruleAliases).toEqual(['A']);
    expect([anyRole!.stepsEvaluated, anyRole!.stepsTruncated, anyRole!.steps.length])
      .toEqual([129, true, 16]);
    expect(allPermissions!.ruleAliases).toEqual(['R', 'W']);
    expect(allPermissions!.stepsEvaluated).toBe(132);
  });

  it('retains an approved role check with its alias, reason and policy revision', () => {
    const { collector, rbac } = makeCollector();
    attachAuthorizationObserver(rbac, collector);
    expect(rbac.hasRole(admin, 'admin')).toBe(true);
    const batch = collector.read('instance', 0);
    expect(batch.state).toBe('ready');
    expect(batch.decisions).toHaveLength(1);
    expect(batch.decisions[0]).toEqual({
      sequence: 1,
      id: 'd1',
      operation: 'role',
      result: true,
      ruleAliases: ['A'],
      steps: [{ ruleAlias: 'A', reason: 'direct-role' }],
      stepsEvaluated: 1,
      stepsTruncated: false,
      reason: 'direct-role',
      policyRevision: 'rev-1',
      ageMs: 0,
    });
    expect(batch.next).toBe(1);
    expect(batch.lost).toBe(0);
  });

  it('reports an inherited role check with the granting role alias', () => {
    const { collector, rbac } = makeCollector();
    attachAuthorizationObserver(rbac, collector);
    expect(rbac.hasRole(admin, 'editor')).toBe(true);
    const decision = collector.read('instance', 0).decisions[0]!;
    expect(decision.result).toBe(true);
    expect(decision.reason).toBe('inherited-role');
    expect(decision.viaRoleAlias).toBe('A');
    expect(decision.steps).toEqual([{
      ruleAlias: 'E',
      reason: 'inherited-role',
      viaRoleAlias: 'A',
    }]);
  });

  it('reports a denied check with the not-held reason and no via role', () => {
    const { collector, rbac } = makeCollector();
    attachAuthorizationObserver(rbac, collector);
    expect(rbac.hasRole(nobody, 'admin')).toBe(false);
    const decision = collector.read('instance', 0).decisions[0]!;
    expect(decision.result).toBe(false);
    expect(decision.reason).toBe('not-held');
    expect(decision.viaRoleAlias).toBeUndefined();
    expect(decision.steps).toEqual([{ ruleAlias: 'A', reason: 'not-held' }]);
  });

  it('reports a permission check granted through a role with the via alias', () => {
    const { collector, rbac } = makeCollector();
    attachAuthorizationObserver(rbac, collector);
    expect(rbac.hasPermission(admin, 'posts.write')).toBe(true);
    const decision = collector.read('instance', 0).decisions[0]!;
    expect(decision.operation).toBe('permission');
    expect(decision.reason).toBe('role-permission');
    expect(decision.viaRoleAlias).toBe('A');
    expect(decision.steps).toEqual([{
      ruleAlias: 'W',
      reason: 'role-permission',
      viaRoleAlias: 'A',
    }]);
  });

  it('drops and counts a decision whose requested rule is not approved', () => {
    const { collector, rbac } = makeCollector();
    attachAuthorizationObserver(rbac, collector);
    // 'posts.write' IS approved; 'not.approved' is not — the denied permission
    // check is dropped and counted, while the approved role check is retained.
    expect(rbac.hasPermission(admin, 'not.approved')).toBe(false);
    expect(rbac.hasRole(admin, 'admin')).toBe(true);
    const batch = collector.read('instance', 0);
    expect(batch.decisions).toHaveLength(1);
    expect(batch.decisions[0]!.operation).toBe('role');
    expect(batch.droppedUnapproved).toBe(1);
  });

  it('retains a compound any-role decision with the evaluated steps', () => {
    const { collector, rbac } = makeCollector();
    attachAuthorizationObserver(rbac, collector);
    const editorPrincipal: IPrincipal = { id: 'p4', roles: ['editor'] };
    expect(rbac.hasAnyRole(editorPrincipal, ['admin', 'editor'])).toBe(true);
    const decision = collector.read('instance', 0).decisions[0]!;
    expect(decision.operation).toBe('any-role');
    expect(decision.result).toBe(true);
    expect(decision.reason).toBe('compound-satisfied');
    expect(decision.ruleAliases).toEqual(['A', 'E']);
    expect(decision.stepsEvaluated).toBe(2);
    expect(decision.stepsTruncated).toBe(false);
    expect(decision.steps).toEqual([
      { ruleAlias: 'A', reason: 'not-held' },
      { ruleAlias: 'E', reason: 'direct-role' },
    ]);
  });

  it('truncates a compound decision to 16 steps but keeps the true count', () => {
    // Approve 20 roles for the truncation path.
    const manyRoles: Record<string, string> = {};
    for (let index = 0; index < 20; index++) {
      manyRoles[`role${index}`] = `r${index}`;
    }
    const policy = compileAuthorizationDiagnosticsOptions({
      enabled: true,
      roles: manyRoles,
      permissions: {},
    });
    const clock = makeClock();
    const registry = makeRegistry(true);
    const service = new RbacService({ roles: {} });
    const many = new AuthorizationObservationCollector(policy, clock.clock, registry, service);
    attachAuthorizationObserver(service, many);
    const requested = Object.keys(manyRoles);
    const principal: IPrincipal = { id: 'p5', roles: [] };
    expect(service.hasAnyRole(principal, requested)).toBe(false);
    const decision = many.read('instance', 0).decisions[0]!;
    expect(decision.steps).toHaveLength(16);
    expect(decision.stepsEvaluated).toBe(20);
    expect(decision.stepsTruncated).toBe(true);
    expect(decision.result).toBe(false);
    expect(decision.reason).toBe('compound-unsatisfied');
  });

  it('evicts the oldest decision past 1024 and reports lost', () => {
    const { collector, rbac } = makeCollector();
    attachAuthorizationObserver(rbac, collector);
    for (let index = 0; index < 1025; index++) {
      rbac.hasRole(admin, 'admin');
    }
    // 1025 decisions, ring of 1024: sequence 1 was evicted, so the oldest
    // retained is 2. A read from 0 reports that one skipped sequence as lost.
    const batch = collector.read('instance', 0, 128);
    expect(batch.decisions).toHaveLength(128);
    expect(batch.decisions[0]!.sequence).toBe(2);
    expect(batch.lost).toBe(1);
    expect(batch.next).toBe(129);
  });

  it('applies the cursor contract: exclusive after, empty echo, beyond refusal', () => {
    const { collector, rbac } = makeCollector();
    attachAuthorizationObserver(rbac, collector);
    rbac.hasRole(admin, 'admin');
    rbac.hasRole(admin, 'editor');
    const page = collector.read('instance', 1, 1);
    expect(page.decisions).toHaveLength(1);
    expect(page.decisions[0]!.sequence).toBe(2);
    expect(page.lost).toBe(0);
    // An empty page echoes the cursor.
    const empty = collector.read('instance', 2);
    expect(empty.decisions).toHaveLength(0);
    expect(empty.next).toBe(2);
    expect(empty.lost).toBe(0);
    // A cursor beyond the sequence refuses with a RangeError.
    expect(() => collector.read('instance', 3)).toThrow(RangeError);
  });

  it('computes ageMs from the clock at read time', () => {
    const { collector, rbac, clock } = makeCollector();
    attachAuthorizationObserver(rbac, collector);
    rbac.hasRole(admin, 'admin');
    clock.advance(250);
    const decision = collector.read('instance', 0).decisions[0]!;
    expect(decision.ageMs).toBe(250);
  });

  it('answers no-data when nothing has been observed', () => {
    const { collector } = makeCollector();
    const batch = collector.read('instance', 0);
    expect(batch.state).toBe('no-data');
    expect(batch.decisions).toHaveLength(0);
    expect(batch.next).toBe(0);
    expect(batch.lost).toBe(0);
  });

  it('latches provider-identity-unavailable when the predicate is absent', () => {
    const { collector, rbac } = makeCollector(makeRegistry('absent'));
    attachAuthorizationObserver(rbac, collector);
    rbac.hasRole(admin, 'admin');
    const batch = collector.read('instance', 0);
    expect(batch.state).toBe('unsupported');
    expect(batch.coverage).toBe('provider-identity-unavailable');
    expect(batch.decisions).toHaveLength(0);
    // The latch is terminal: the observer is detached and the ring cleared.
    expect(authorizationObserverOf(rbac)).toBeUndefined();
    rbac.hasRole(admin, 'admin');
    expect(collector.read('instance', 0).decisions).toHaveLength(0);
  });

  it('latches custom-provider when the predicate answers false', () => {
    const { collector, rbac } = makeCollector(makeRegistry(false));
    attachAuthorizationObserver(rbac, collector);
    rbac.hasRole(admin, 'admin');
    const batch = collector.read('instance', 0);
    expect(batch.state).toBe('unsupported');
    expect(batch.coverage).toBe('custom-provider');
    expect(batch.decisions).toHaveLength(0);
    expect(authorizationObserverOf(rbac)).toBeUndefined();
  });

  it('latches at read time when the provider was replaced after capture', () => {
    // A registry whose isCurrent answer can be flipped, modelling a provider
    // replacement between capture and read.
    let current = true;
    const registry = {
      isCurrent: (_token: unknown, _instance: unknown) => current,
    } as unknown as IServiceRegistry;
    const clock = makeClock();
    const rbac = new RbacService(RBAC_CONFIG);
    const policy = compileAuthorizationDiagnosticsOptions({
      enabled: true,
      roles: { admin: 'A' },
      permissions: {},
    });
    const collector = new AuthorizationObservationCollector(policy, clock.clock, registry, rbac);
    attachAuthorizationObserver(rbac, collector);
    rbac.hasRole(admin, 'admin');
    expect(collector.read('instance', 0).decisions).toHaveLength(1);
    // The provider is replaced: the collector's service is no longer current.
    current = false;
    const batch = collector.read('instance', 0);
    expect(batch.state).toBe('unsupported');
    expect(batch.coverage).toBe('custom-provider');
    expect(batch.decisions).toHaveLength(0);
    // Terminal: the ring stays cleared and the observer detaches.
    current = true;
    rbac.hasRole(admin, 'admin');
    expect(collector.read('instance', 0).decisions).toHaveLength(0);
    expect(authorizationObserverOf(rbac)).toBeUndefined();
  });

  it('answers a closed empty batch after close', () => {
    const { collector, rbac } = makeCollector();
    attachAuthorizationObserver(rbac, collector);
    rbac.hasRole(admin, 'admin');
    collector.close();
    // A closed source clears the ring and echoes every cursor it issued:
    // no decisions, no refusal.
    for (const cursor of [0, 1]) {
      const batch = collector.read('instance', cursor);
      expect(batch.state).toBe('no-data');
      expect(batch.closed).toBe(true);
      expect(batch.decisions).toHaveLength(0);
      expect(batch.next).toBe(cursor);
      expect(batch.lost).toBe(0);
    }
    // A cursor it never issued is refused exactly as while running — a
    // closed source must not echo an invented cursor back as `next`.
    expect(() => collector.read('instance', 5)).toThrow(RangeError);
    expect(() => collector.read('instance', 2)).toThrow('beyond the retained sequence');
  });

  it('refuses malformed read arguments with fixed RangeErrors', () => {
    const { collector } = makeCollector();
    expect(() => collector.read('', 0)).toThrow('instance identifier');
    expect(() => collector.read('instance', -1)).toThrow('non-negative safe integer');
    expect(() => collector.read('instance', 0, 0)).toThrow('1 to 128');
    expect(() => collector.read('instance', 0, 129)).toThrow('1 to 128');
  });

  it('retains a satisfied all-permissions decision with the evaluated steps', () => {
    const { collector, rbac } = makeCollector();
    attachAuthorizationObserver(rbac, collector);
    expect(rbac.hasAllPermissions(admin, ['posts.read', 'posts.write'])).toBe(true);
    const decision = collector.read('instance', 0).decisions[0]!;
    expect(decision.operation).toBe('all-permissions');
    expect(decision.result).toBe(true);
    expect(decision.reason).toBe('compound-satisfied');
    expect(decision.ruleAliases).toEqual(['R', 'W']);
    expect(decision.stepsEvaluated).toBe(2);
    expect(decision.stepsTruncated).toBe(false);
    // The principal holds no direct permissions: both checks resolve through
    // the `admin` role, so each step carries the role-permission reason and
    // the granting principal role's alias.
    expect(decision.steps).toEqual([
      { ruleAlias: 'R', reason: 'role-permission', viaRoleAlias: 'A' },
      { ruleAlias: 'W', reason: 'role-permission', viaRoleAlias: 'A' },
    ]);
  });

  it('reports an unsatisfied all-permissions decision with the failing step', () => {
    const { collector, rbac } = makeCollector();
    attachAuthorizationObserver(rbac, collector);
    expect(rbac.hasAllPermissions(nobody, ['posts.read', 'posts.write'])).toBe(false);
    const decision = collector.read('instance', 0).decisions[0]!;
    expect(decision.result).toBe(false);
    expect(decision.reason).toBe('compound-unsatisfied');
    // The evaluator short-circuits on the first failing permission.
    expect(decision.stepsEvaluated).toBe(1);
    expect(decision.steps).toEqual([{ ruleAlias: 'R', reason: 'not-held' }]);
  });

  it('drops and counts an all-permissions decision naming an unapproved permission', () => {
    const { collector, rbac } = makeCollector();
    attachAuthorizationObserver(rbac, collector);
    // 'not.approved' is not in the policy: the whole decision is dropped.
    expect(rbac.hasAllPermissions(admin, ['posts.read', 'not.approved'])).toBe(false);
    const batch = collector.read('instance', 0);
    expect(batch.decisions).toHaveLength(0);
    expect(batch.droppedUnapproved).toBe(1);
  });

  it('reports an all-permissions step granted through a role with the via alias', () => {
    const policy = compileAuthorizationDiagnosticsOptions({
      enabled: true,
      roles: { owner: 'O', worker: 'W' },
      permissions: { 'jobs.run': 'J' },
    });
    const clock = makeClock();
    const registry = makeRegistry(true);
    const service = new RbacService({
      roles: {
        owner: { permissions: [], inherits: ['worker'] },
        worker: { permissions: ['jobs.run'] },
      },
    });
    const collector = new AuthorizationObservationCollector(policy, clock.clock, registry, service);
    attachAuthorizationObserver(service, collector);
    const owner: IPrincipal = { id: 'p6', roles: ['owner'] };
    expect(service.hasAllPermissions(owner, ['jobs.run'])).toBe(true);
    const decision = collector.read('instance', 0).decisions[0]!;
    expect(decision.result).toBe(true);
    // The grant is attributed to the PRINCIPAL'S role that reaches the
    // permission (`owner`), not to the leaf role (`worker`) that lists it:
    // the evaluator names one identifiable granting principal role.
    expect(decision.steps).toEqual([{
      ruleAlias: 'J',
      reason: 'role-permission',
      viaRoleAlias: 'O',
    }]);
  });

  it('reports the true count when an all-permissions evaluation short-circuits on its first step', () => {
    // An unbounded input (20 permissions) that fails immediately: the
    // decision is complete — one evaluated step, no truncation — and the
    // input size never leaks into the observation.
    const manyPermissions: Record<string, string> = {};
    for (let index = 0; index < 20; index++) {
      manyPermissions[`perm${index}`] = `p${index}`;
    }
    const policy = compileAuthorizationDiagnosticsOptions({
      enabled: true,
      roles: {},
      permissions: manyPermissions,
    });
    const clock = makeClock();
    const registry = makeRegistry(true);
    const service = new RbacService({ roles: {} });
    const many = new AuthorizationObservationCollector(policy, clock.clock, registry, service);
    attachAuthorizationObserver(service, many);
    const requested = Object.keys(manyPermissions);
    const principal: IPrincipal = { id: 'p7', roles: [] };
    expect(service.hasAllPermissions(principal, requested)).toBe(false);
    const decision = many.read('instance', 0).decisions[0]!;
    expect(decision.steps).toHaveLength(1);
    expect(decision.stepsEvaluated).toBe(1);
    expect(decision.stepsTruncated).toBe(false);
    expect(decision.result).toBe(false);
    expect(decision.reason).toBe('compound-unsatisfied');
  });

  it('retains a satisfied any-role decision whose grant sits past step 16', () => {
    // The granting role is the 18th of 20: the evaluation short-circuits
    // past the 16-step retention bound, so the decision is RETAINED with the
    // true count and an explicit truncation flag (plan §3.3).
    const manyRoles: Record<string, string> = {};
    for (let index = 0; index < 20; index++) {
      manyRoles[`role${index}`] = `r${index}`;
    }
    const policy = compileAuthorizationDiagnosticsOptions({
      enabled: true,
      roles: manyRoles,
      permissions: {},
    });
    const clock = makeClock();
    const registry = makeRegistry(true);
    const service = new RbacService({ roles: {} });
    const many = new AuthorizationObservationCollector(policy, clock.clock, registry, service);
    attachAuthorizationObserver(service, many);
    const requested = Object.keys(manyRoles);
    const principal: IPrincipal = { id: 'p8', roles: ['role17'] };
    expect(service.hasAnyRole(principal, requested)).toBe(true);
    const decision = many.read('instance', 0).decisions[0]!;
    expect(decision.result).toBe(true);
    expect(decision.reason).toBe('compound-satisfied');
    expect(decision.steps).toHaveLength(16);
    expect(decision.stepsEvaluated).toBe(18);
    expect(decision.stepsTruncated).toBe(true);
    // The retained steps are the first 16 evaluated checks, all unsatisfied.
    expect(decision.steps.every((step) => step.reason === 'not-held')).toBe(true);
  });

  it('retains an unsatisfied all-permissions decision over 20 permissions with the true count', () => {
    const manyPermissions: Record<string, string> = {};
    for (let index = 0; index < 20; index++) {
      manyPermissions[`perm${index}`] = `p${index}`;
    }
    const policy = compileAuthorizationDiagnosticsOptions({
      enabled: true,
      roles: {},
      permissions: manyPermissions,
    });
    const clock = makeClock();
    const registry = makeRegistry(true);
    const service = new RbacService({ roles: {} });
    const many = new AuthorizationObservationCollector(policy, clock.clock, registry, service);
    attachAuthorizationObserver(service, many);
    const requested = Object.keys(manyPermissions);
    // The principal holds the first 19 directly: the evaluation runs all 20
    // steps and fails on the last, past the 16-step retention bound.
    const principal: IPrincipal = { id: 'p9', permissions: requested.slice(0, 19) };
    expect(service.hasAllPermissions(principal, requested)).toBe(false);
    const decision = many.read('instance', 0).decisions[0]!;
    expect(decision.result).toBe(false);
    expect(decision.reason).toBe('compound-unsatisfied');
    expect(decision.steps).toHaveLength(16);
    expect(decision.stepsEvaluated).toBe(20);
    expect(decision.stepsTruncated).toBe(true);
    expect(decision.steps.every((step) => step.reason === 'direct-permission')).toBe(true);
  });

  it('reports a 16-step all-permissions decision as complete, not truncated', () => {
    // A decision that evaluated exactly 16 steps is complete: the flag is
    // required rather than inferable from the list length (plan §3.3).
    const sixteenPermissions: Record<string, string> = {};
    for (let index = 0; index < 16; index++) {
      sixteenPermissions[`perm${index}`] = `p${index}`;
    }
    const policy = compileAuthorizationDiagnosticsOptions({
      enabled: true,
      roles: {},
      permissions: sixteenPermissions,
    });
    const clock = makeClock();
    const registry = makeRegistry(true);
    const service = new RbacService({ roles: {} });
    const many = new AuthorizationObservationCollector(policy, clock.clock, registry, service);
    attachAuthorizationObserver(service, many);
    const requested = Object.keys(sixteenPermissions);
    const principal: IPrincipal = { id: 'p10', permissions: requested };
    expect(service.hasAllPermissions(principal, requested)).toBe(true);
    const decision = many.read('instance', 0).decisions[0]!;
    expect(decision.result).toBe(true);
    expect(decision.reason).toBe('compound-satisfied');
    expect(decision.steps).toHaveLength(16);
    expect(decision.stepsEvaluated).toBe(16);
    expect(decision.stepsTruncated).toBe(false);
  });

  it('never lets an observer throw change the returned boolean', () => {
    const { collector, rbac } = makeCollector();
    // A throwing observer: wrap the collector in one that throws.
    const throwing = {
      onRole: () => {
        throw new Error('boom');
      },
      onPermission: () => {
        throw new Error('boom');
      },
      onAnyRole: () => {
        throw new Error('boom');
      },
      onAllPermissions: () => {
        throw new Error('boom');
      },
    };
    attachAuthorizationObserver(rbac, throwing);
    expect(() => rbac.hasRole(admin, 'admin')).not.toThrow();
    expect(rbac.hasRole(admin, 'admin')).toBe(true);
    expect(rbac.hasRole(nobody, 'admin')).toBe(false);
    // The throwing observer is replaced by the collector again.
    attachAuthorizationObserver(rbac, collector);
    expect(rbac.hasRole(admin, 'admin')).toBe(true);
  });
});
