/**
 * The authorization policy evaluator's fixed semantics (M110a §3.4–§3.5,
 * §3.7). Each rule is a row; the plan's negative controls — truthiness instead
 * of `=== true`, dropping the `hasOwn` guard, skipping `before` — each fail a
 * named row here.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { httpStatusHintOf } from '@setu-ts/common';
import type { ILogger, IPrincipal, PolicyDefinition } from '@setu-ts/common';

import { PolicyService } from '../../../src/policies/policy-service.ts';
import { AuthorizationDeniedError, UnknownPolicyError } from '../../../src/policies/errors.ts';
import { AuthPluginConfigurationError } from '../../../src/errors.ts';

const ALICE: IPrincipal = { id: 'alice' };
const ADMIN: IPrincipal = { id: 'root', roles: ['admin'] };

interface LogLine {
  readonly level: string;
  readonly message: string;
  readonly meta: Record<string, unknown> | undefined;
}

/** A logger recording every call, so "reported once" is assertable. */
function recordingLogger(): { readonly logger: ILogger; readonly lines: LogLine[] } {
  const lines: LogLine[] = [];
  const record = (level: string) => (message: string, meta?: Record<string, unknown>): void => {
    lines.push({ level, message, meta });
  };
  const logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    trace: record('trace'),
    child: () => logger,
  } as unknown as ILogger;
  return { logger, lines };
}

/** Builds a service holding one policy whose check and before are given. */
function serviceWith(
  check: (principal: IPrincipal, target: unknown) => unknown,
  before?: (principal: IPrincipal, ability: string, target: unknown) => unknown,
): { readonly service: PolicyService; readonly lines: LogLine[] } {
  const { logger, lines } = recordingLogger();
  const service = new PolicyService(() => logger);
  const policy = {
    name: 'doc',
    abilities: {
      edit: check,
      view: { anonymous: true, check: (p: IPrincipal | null) => p === null || p.id === 'alice' },
    },
    ...(before === undefined ? {} : { before }),
  } as unknown as PolicyDefinition;
  service.define(policy);
  return { service, lines };
}

describe('PolicyService — only a literal true allows', () => {
  const RETURNS: readonly { readonly value: unknown; readonly allowed: boolean }[] = [
    { value: true, allowed: true },
    { value: false, allowed: false },
    { value: 1, allowed: false },
    { value: 'yes', allowed: false },
    { value: {}, allowed: false },
    { value: undefined, allowed: false },
    { value: null, allowed: false },
  ];
  for (const row of RETURNS) {
    it(`a check returning ${JSON.stringify(row.value) ?? 'undefined'} → ${row.allowed}`, async () => {
      const { service } = serviceWith(() => row.value);
      expect(await service.can(ALICE, 'doc', 'edit')).toBe(row.allowed);
    });
  }

  it('awaits an asynchronous check', async () => {
    const { service } = serviceWith(() => Promise.resolve(true));
    expect(await service.can(ALICE, 'doc', 'edit')).toBe(true);
  });

  it('passes the principal and target through unchanged', async () => {
    const seen: unknown[] = [];
    const target = { id: 'd1' };
    const { service } = serviceWith((p, t) => {
      seen.push(p, t);
      return true;
    });
    await service.can(ALICE, 'doc', 'edit', target);
    expect(seen).toEqual([ALICE, target]);
    expect(seen[1]).toBe(target);
  });
});

describe('PolicyService — anonymous principals', () => {
  it('denies an anonymous principal WITHOUT calling a non-anonymous check', async () => {
    let calls = 0;
    const { service } = serviceWith(() => {
      calls += 1;
      return true;
    });
    expect(await service.can(null, 'doc', 'edit')).toBe(false);
    expect(calls).toBe(0);
  });

  it('calls an anonymous ability with null', async () => {
    const { service } = serviceWith(() => true);
    expect(await service.can(null, 'doc', 'view')).toBe(true);
    expect(await service.can({ id: 'mallory' }, 'doc', 'view')).toBe(false);
  });

  it('skips before for an anonymous principal', async () => {
    let calls = 0;
    const { service } = serviceWith(() => false, () => {
      calls += 1;
      return true;
    });
    expect(await service.can(null, 'doc', 'view')).toBe(true);
    expect(calls).toBe(0);
  });
});

describe('PolicyService — before', () => {
  const VERDICTS: readonly {
    readonly verdict: unknown;
    readonly checkResult: boolean;
    readonly allowed: boolean;
    readonly checkCalled: boolean;
  }[] = [
    { verdict: true, checkResult: false, allowed: true, checkCalled: false },
    { verdict: undefined, checkResult: true, allowed: true, checkCalled: true },
    { verdict: undefined, checkResult: false, allowed: false, checkCalled: true },
    { verdict: false, checkResult: true, allowed: false, checkCalled: false },
    { verdict: null, checkResult: true, allowed: false, checkCalled: false },
    { verdict: 1, checkResult: true, allowed: false, checkCalled: false },
  ];
  for (const row of VERDICTS) {
    it(`before → ${JSON.stringify(row.verdict) ?? 'undefined'} with check ${row.checkResult}: ${row.allowed}`, async () => {
      let checkCalled = false;
      const { service } = serviceWith(() => {
        checkCalled = true;
        return row.checkResult;
      }, () => row.verdict);
      expect(await service.can(ALICE, 'doc', 'edit')).toBe(row.allowed);
      expect(checkCalled).toBe(row.checkCalled);
    });
  }

  it('receives the principal, ability and target, with the definition as this', async () => {
    const seen: unknown[] = [];
    const service = new PolicyService(() => undefined);
    service.define({
      name: 'doc',
      abilities: { edit: () => false },
      before(this: unknown, principal, ability, target) {
        seen.push(principal, ability, target, (this as PolicyDefinition).name);
        return true;
      },
    } as PolicyDefinition);
    expect(await service.can(ADMIN, 'doc', 'edit', 't')).toBe(true);
    expect(seen).toEqual([ADMIN, 'edit', 't', 'doc']);
  });

  it('awaits an asynchronous before', async () => {
    const { service } = serviceWith(() => false, () => Promise.resolve(true));
    expect(await service.can(ALICE, 'doc', 'edit')).toBe(true);
  });
});

describe('PolicyService — a throwing policy denies and is reported once', () => {
  const THROWS: readonly { readonly stage: 'before' | 'check'; readonly async: boolean }[] = [
    { stage: 'check', async: false },
    { stage: 'check', async: true },
    { stage: 'before', async: false },
    { stage: 'before', async: true },
  ];
  for (const row of THROWS) {
    it(`a ${row.async ? 'rejecting' : 'throwing'} ${row.stage} denies`, async () => {
      const fail = (): unknown => {
        if (row.async) return Promise.reject(new Error('db down'));
        throw new Error('db down');
      };
      const { service, lines } = row.stage === 'check'
        ? serviceWith(fail)
        : serviceWith(() => true, fail);
      expect(await service.can(ALICE, 'doc', 'edit', { secret: 's3cret' })).toBe(false);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.level).toBe('error');
      expect(lines[0]?.meta?.policy).toBe('doc');
      expect(lines[0]?.meta?.ability).toBe('edit');
      expect(lines[0]?.meta?.stage).toBe(row.stage);
      expect((lines[0]?.meta?.error as { message?: string }).message).toBe('db down');
      // Never the target and never the principal.
      expect(JSON.stringify(lines[0]?.meta)).not.toContain('s3cret');
      expect(JSON.stringify(lines[0]?.meta)).not.toContain('alice');
    });
  }

  it('denies an anonymous principal with authentication-required when an anonymous check throws', async () => {
    const service = new PolicyService(() => undefined);
    service.define({
      name: 'doc',
      abilities: { view: { anonymous: true, check: () => Promise.reject(new Error('x')) } },
    } as PolicyDefinition);
    const rejection = await service.authorize(null, 'doc', 'view').catch((e) => e);
    expect(rejection).toBeInstanceOf(AuthorizationDeniedError);
    expect((rejection as AuthorizationDeniedError).failure).toBe('authentication-required');
  });

  it('a throwing logger cannot change the outcome', async () => {
    const service = new PolicyService(() => {
      throw new Error('logger down');
    });
    service.define({
      name: 'doc',
      abilities: {
        edit: () => {
          throw new Error('policy down');
        },
      },
    } as PolicyDefinition);
    expect(await service.can(ALICE, 'doc', 'edit')).toBe(false);
  });

  it('reads the logger at call time', async () => {
    const holder: { logger?: ILogger } = {};
    const service = new PolicyService(() => holder.logger);
    service.define({
      name: 'doc',
      abilities: {
        edit: () => {
          throw new Error('late');
        },
      },
    } as PolicyDefinition);
    const { logger, lines } = recordingLogger();
    holder.logger = logger;
    await service.can(ALICE, 'doc', 'edit');
    expect(lines).toHaveLength(1);
  });
});

describe('PolicyService — unknown names reject, never deny', () => {
  it('rejects an unknown policy by name', async () => {
    const { service } = serviceWith(() => true);
    const rejection = await service.can(ALICE, 'nope', 'edit').catch((e) => e);
    expect(rejection).toBeInstanceOf(UnknownPolicyError);
    expect((rejection as UnknownPolicyError).policy).toBe('nope');
    expect((rejection as UnknownPolicyError).ability).toBeUndefined();
    expect((rejection as Error).message).toContain('"nope"');
  });

  it('rejects an unknown ability by name', async () => {
    const { service } = serviceWith(() => true);
    const rejection = await service.authorize(ALICE, 'doc', 'delete').catch((e) => e);
    expect(rejection).toBeInstanceOf(UnknownPolicyError);
    expect((rejection as UnknownPolicyError).ability).toBe('delete');
  });

  for (const inherited of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    it(`never resolves the inherited name ${inherited} as an ability`, async () => {
      const { service } = serviceWith(() => true);
      await expect(service.can(ALICE, 'doc', inherited)).rejects.toBeInstanceOf(
        UnknownPolicyError,
      );
      expect(service.describe('doc', inherited)).toBeUndefined();
    });
  }

  it('labels a non-string policy and ability without converting them', async () => {
    const { service } = serviceWith(() => true);
    const exotic = Object.create(null) as never;
    const byPolicy = await service.can(ALICE, exotic, 'edit').catch((e) => e);
    expect((byPolicy as UnknownPolicyError).policy).toBe('[object]');
    const byAbility = await service.can(ALICE, 'doc', exotic).catch((e) => e);
    expect((byAbility as UnknownPolicyError).ability).toBe('[object]');
    const bySymbol = await service.can(ALICE, Symbol('x') as never, 'edit').catch((e) => e);
    expect((bySymbol as UnknownPolicyError).policy).toBe('[symbol]');
  });

  it('accepts a policy object, looked up by its name', async () => {
    const { service } = serviceWith(() => true);
    const reference = { name: 'doc', abilities: { edit: () => false } } as PolicyDefinition;
    // The REGISTERED policy is evaluated, not the object's own check.
    expect(await service.can(ALICE, reference, 'edit')).toBe(true);
  });

  it('never throws synchronously', () => {
    const { service } = serviceWith(() => true);
    expect(() => {
      const pending = service.can(ALICE, 'nope', 'edit');
      pending.catch(() => {});
    }).not.toThrow();
  });
});

describe('PolicyService — authorize', () => {
  it('resolves on allow', async () => {
    const { service } = serviceWith(() => true);
    await expect(service.authorize(ALICE, 'doc', 'edit')).resolves.toBeUndefined();
  });

  it('rejects a signed-in denial as insufficient-privileges with a 403 hint', async () => {
    const { service } = serviceWith(() => false);
    const rejection = await service.authorize(ALICE, 'doc', 'edit').catch((e) => e);
    expect(rejection).toBeInstanceOf(AuthorizationDeniedError);
    const denied = rejection as AuthorizationDeniedError;
    expect([denied.failure, denied.policy, denied.ability]).toEqual([
      'insufficient-privileges',
      'doc',
      'edit',
    ]);
    expect(httpStatusHintOf(denied)).toEqual({
      status: 403,
      title: 'Forbidden',
      detail: 'Insufficient privileges',
    });
  });

  it('rejects an anonymous denial as authentication-required with a 401 hint', async () => {
    const { service } = serviceWith(() => true);
    const rejection = await service.authorize(null, 'doc', 'edit').catch((e) => e);
    expect((rejection as AuthorizationDeniedError).failure).toBe('authentication-required');
    expect(httpStatusHintOf(rejection)?.status).toBe(401);
  });
});

describe('PolicyService — describe, define and seal', () => {
  it('describes a registered ability and nothing else', () => {
    const { service } = serviceWith(() => true);
    expect(service.describe('doc', 'edit')).toEqual({ anonymous: false });
    expect(service.describe('doc', 'view')).toEqual({ anonymous: true });
    expect(service.describe('doc', 'nope')).toBeUndefined();
    expect(service.describe('nope', 'edit')).toBeUndefined();
  });

  it('refuses a duplicate name', () => {
    const { service } = serviceWith(() => true);
    expect(() => service.define({ name: 'doc', abilities: { x: () => true } } as PolicyDefinition))
      .toThrow(/already registered/);
  });

  it('refuses a malformed definition', () => {
    const service = new PolicyService(() => undefined);
    expect(() => service.define({ name: 'Doc', abilities: {} } as PolicyDefinition)).toThrow(
      AuthPluginConfigurationError,
    );
  });

  it('refuses define once sealed, and keeps evaluating', async () => {
    const { service } = serviceWith(() => true);
    service.seal();
    expect(() => service.define({ name: 'late', abilities: { x: () => true } } as PolicyDefinition))
      .toThrow(/once the application has started/);
    expect(await service.can(ALICE, 'doc', 'edit')).toBe(true);
  });

  it('evaluates the validated copy, not the caller object', async () => {
    const service = new PolicyService(() => undefined);
    const abilities: Record<string, () => boolean> = { edit: () => true };
    service.define({ name: 'doc', abilities } as PolicyDefinition);
    abilities.edit = () => false;
    expect(await service.can(ALICE, 'doc', 'edit')).toBe(true);
  });
});
