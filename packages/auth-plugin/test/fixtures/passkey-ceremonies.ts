/**
 * Shared harness for the ceremony unit tests.
 *
 * Builds a `PasskeyCeremonies` over a fake session service, a fake sign-in
 * owner that mimics `AuthSessionService`'s record semantics over the SAME
 * session (so `pending` and `promotePending` interact with the ceremonies the
 * way the real service does), and a controllable clock.
 *
 * @module
 */
import type {
  IAuthSessionService,
  IPrincipal,
  IRequestContext,
  ISession,
  PendingSignIn,
  SignInOptions,
  SignInOutcome,
} from '@setu-ts/common';
import type { IPasskeyStore } from '../../src/stores/passkey-store.ts';
import type { PasskeyOptions } from '../../src/interfaces/index.ts';
import { MemoryPasskeyStore } from '../../src/stores/passkey-store.ts';
import {
  AUTH_SESSION_KEY,
  PENDING_MFA_SESSION_KEY,
} from '../../src/sign-in/auth-session-service.ts';
import { compilePasskeys } from '../../src/passkeys/ceremonies.ts';
import type { CompiledPasskeys } from '../../src/passkeys/ceremonies.ts';
import { PasskeyCeremonies } from '../../src/passkeys/ceremonies.ts';
import { createFakeRuntime } from './fake-runtime.ts';
import { createFakeSession, createFakeSessionService } from './fake-session.ts';

/** The origin and RP ID the unit tests run against. */
export const ORIGIN = 'http://localhost';
export const RP_ID = 'localhost';

/** The recorded sign-ins of the fake sign-in owner. */
export interface RecordedSignIn {
  readonly principal: IPrincipal;
  readonly methods: readonly string[];
}

/**
 * A fake `IAuthSessionService` that mimics the real `AuthSessionService`'s
 * session-record semantics: `signIn` writes the signed-in record (holding it
 * back as pending when `required` answers true), `pending` reads the pending
 * record, `promotePending` moves it. No session-id rotation is mimicked — the
 * ceremonies never read the id.
 */
export class FakeAuthSessionService implements IAuthSessionService {
  readonly #session: ISession;
  readonly #now: () => number;
  readonly #required: (principal: IPrincipal, methods: readonly string[]) => boolean;
  readonly recordedSignIns: RecordedSignIn[] = [];

  constructor(session: ISession, now: () => number, required: () => boolean = () => false) {
    this.#session = session;
    this.#now = now;
    this.#required = required;
  }

  /** @inheritDoc */
  signIn(
    ctx: IRequestContext,
    principal: IPrincipal,
    options: SignInOptions,
  ): Promise<SignInOutcome> {
    void ctx;
    this.recordedSignIns.push({ principal, methods: [...options.methods] });
    if (this.#required(principal, [...options.methods])) {
      this.#session.set(PENDING_MFA_SESSION_KEY, {
        principal,
        methods: [...options.methods],
        at: this.#now(),
      });
      this.#session.delete(AUTH_SESSION_KEY);
      return Promise.resolve({ status: 'second-factor-required' });
    }
    this.#session.set(AUTH_SESSION_KEY, {
      principal,
      methods: [...options.methods],
      at: this.#now(),
    });
    this.#session.delete(PENDING_MFA_SESSION_KEY);
    return Promise.resolve({ status: 'signed-in' });
  }

  /** @inheritDoc */
  current(ctx: IRequestContext): IPrincipal | null {
    void ctx;
    const raw = this.#session.get<Record<string, unknown>>(AUTH_SESSION_KEY);
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const principal = raw.principal as IPrincipal | undefined;
    return typeof principal?.id === 'string' ? principal : null;
  }

  /** @inheritDoc */
  pending(ctx: IRequestContext): PendingSignIn | null {
    void ctx;
    const raw = this.#session.get<Record<string, unknown>>(PENDING_MFA_SESSION_KEY);
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const at = raw.at as number;
    if (this.#now() - at > 300_000) {
      return null;
    }
    return raw as unknown as PendingSignIn;
  }

  /** @inheritDoc */
  signOut(ctx: IRequestContext): void {
    void ctx;
    this.#session.delete(AUTH_SESSION_KEY);
  }

  /**
   * Promotes a pending record to the signed-in key, mirroring the real
   * service's internal promotion seam the ceremonies narrow to.
   */
  promotePending(
    ctx: IRequestContext,
    method: 'pwd' | 'otp' | 'pop' | 'fed',
  ): 'signed-in' | 'no-pending' {
    void ctx;
    const pending = this.pending(ctx);
    if (pending === null) {
      return 'no-pending';
    }
    this.#session.delete(PENDING_MFA_SESSION_KEY);
    this.#session.set(AUTH_SESSION_KEY, {
      principal: pending.principal,
      methods: [...pending.methods, method],
      at: this.#now(),
    });
    return 'signed-in';
  }
}

/** The built harness. */
export interface CeremoniesHarness {
  readonly ceremonies: PasskeyCeremonies;
  readonly config: CompiledPasskeys;
  readonly store: IPasskeyStore;
  readonly runtime: ReturnType<typeof createFakeRuntime>;
  readonly session: ReturnType<typeof createFakeSession>;
  readonly ctx: IRequestContext;
  readonly authSession: FakeAuthSessionService;
}

/** Options for {@linkcode createCeremoniesHarness}. */
export interface HarnessOptions {
  /** Overrides parts of the passkeys option. */
  readonly passkeys?: Partial<PasskeyOptions>;
  /** The principal the signed-in record holds; `null` leaves the session anonymous. */
  readonly principal?: IPrincipal | null;
}

/**
 * Builds the ceremony harness with a signed-in `alice` principal by default.
 *
 * @param options - The passkeys overrides and the signed-in principal
 * @returns The harness
 */
export function createCeremoniesHarness(options: HarnessOptions = {}): CeremoniesHarness {
  const runtime = createFakeRuntime();
  const session = createFakeSession();
  const authSession = new FakeAuthSessionService(session, () => runtime.now());
  const principal = options.principal === undefined
    ? { id: 'alice', roles: ['user'] }
    : options.principal;
  if (principal !== null) {
    session.set(AUTH_SESSION_KEY, { principal, methods: ['pwd'], at: runtime.now() });
  }
  const passkeys: PasskeyOptions = {
    rpId: RP_ID,
    rpName: 'Setu Test',
    origins: [ORIGIN],
    store: new MemoryPasskeyStore(),
    resolvePrincipal: () => Promise.resolve({ id: 'alice', roles: ['user'] }),
    ...options.passkeys,
  };
  const config = compilePasskeys(passkeys);
  const ctx = {} as IRequestContext;
  const ceremonies = new PasskeyCeremonies({
    config,
    runtime,
    sessionService: createFakeSessionService(session),
    authSession,
  });
  return {
    ceremonies,
    config,
    store: passkeys.store,
    runtime,
    session,
    ctx,
    authSession,
  };
}
