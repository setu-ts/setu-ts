/**
 * TOTP enrolment, step-claim, lockout, and recovery-code store.
 *
 * The port is async so a remote backend (Redis, a database) can implement it
 * without a breaking change. `MemoryTotpStore` is the default for tests and
 * single-process development.
 *
 * The secret is stored as given (base32); a production store should encrypt it
 * at rest.
 *
 * @module
 */

/** A TOTP enrolment record. */
export interface TotpEnrolment {
  /**
   * The base32 secret (RFC 4648, no padding) that verifies today. While a
   * re-enrolment awaits confirmation this stays the OLD confirmed secret, so
   * beginning a new enrolment never removes the working factor.
   */
  readonly secret: string;
  /** The label shown in the authenticator app, belonging to {@linkcode secret}. */
  readonly label: string;
  /** Whether the enrolment has been confirmed with a valid code. */
  confirmed: boolean;
  /**
   * The last claimed TOTP step; a step must be greater than this to be accepted.
   * Monotonic across re-enrolment: a step claimed under the old secret stays
   * claimed after the new one is confirmed.
   */
  lastClaimedStep: number;
  /**
   * The base32 secret of a re-enrolment awaiting confirmation, if one is in
   * progress. Only {@linkcode ITotpStore} and the confirmation path read it;
   * verification of a confirmed factor uses {@linkcode secret} alone.
   */
  pendingSecret?: string;
  /** The label belonging to {@linkcode pendingSecret}. */
  pendingLabel?: string;
}

/** The result of reserving an attempt for lockout purposes. */
export interface ReserveAttemptResult {
  /** Whether the attempt is within the limit. */
  readonly allowed: boolean;
  /** The number of attempts in the current window, including this one. */
  readonly count: number;
}

/**
 * Store port for TOTP enrolment, step claims, lockout, and recovery codes.
 *
 * All methods are async so remote backends can implement the interface without
 * a breaking change.
 */
export interface ITotpStore {
  /**
   * Reads the enrolment for a principal, or `null` when none exists.
   */
  getEnrolment(principalId: string): Promise<TotpEnrolment | null>;

  /**
   * Stores or updates an enrolment, including its optional pending secret. A
   * backend that persists only some fields must persist `pendingSecret` and
   * `pendingLabel` too: a re-enrolment awaiting confirmation is otherwise lost,
   * and the old confirmed secret comes back.
   */
  saveEnrolment(principalId: string, enrolment: TotpEnrolment): Promise<void>;

  /**
   * Deletes the enrolment for a principal, including any recovery codes
   * and attempt counts.
   */
  deleteEnrolment(principalId: string): Promise<void>;

  /**
   * Atomically claims a TOTP step for a principal.
   *
   * Succeeds only when `step` is greater than the last claimed step, so the
   * same code — and any earlier code — cannot be replayed. Returns `true`
   * when the step was claimed, `false` when it was at or below the last
   * claimed step (replay) or no enrolment exists.
   */
  claimStep(principalId: string, step: number): Promise<boolean>;

  /**
   * Atomically reserves an attempt for lockout.
   *
   * Counts the attempt and answers whether it is within the limit in one
   * operation. Attempts are counted BEFORE the code is checked, not failures
   * after it: a read-the-count-then-record-a-failure pair lets N concurrent
   * guesses all read a count under the limit, so a burst would bypass the
   * lockout.
   *
   * An attempt refused as over the limit is NOT recorded. Recording it would let
   * an attacker who keeps guessing hold the account locked indefinitely — the
   * window would never clear — and would grow the stored count without bound.
   * Only allowed attempts count, so a lock lifts `windowMs` after the oldest
   * counted attempt, whatever arrives meanwhile.
   *
   * @param principalId - The principal
   * @param now - The current wall-clock time in milliseconds
   * @param options - The limit and window
   */
  reserveAttempt(
    principalId: string,
    now: number,
    options: { readonly limit: number; readonly windowMs: number },
  ): Promise<ReserveAttemptResult>;

  /**
   * Clears the attempt count for a principal (called on successful verification).
   */
  clearAttempts(principalId: string): Promise<void>;

  /**
   * Stores recovery codes for a principal, replacing any existing set.
   *
   * Codes are stored as SHA-256 digests (hex), not plaintext.
   *
   * @param principalId - The principal
   * @param digests - The SHA-256 hex digests of the recovery codes
   */
  saveRecoveryCodes(principalId: string, digests: readonly string[]): Promise<void>;

  /**
   * Atomically consumes a recovery code by its SHA-256 digest.
   *
   * Finds the index matching `digest` and marks it consumed in one operation,
   * so two concurrent uses of the same code cannot both succeed. Returns
   * `true` when the code was consumed, `false` when no matching digest exists
   * or it was already consumed.
   *
   * @param principalId - The principal
   * @param digest - The SHA-256 hex digest of the recovery code
   */
  consumeRecoveryCode(principalId: string, digest: string): Promise<boolean>;
}

/** Attempt tracking for the memory store. */
interface MemoryAttempts {
  /** The timestamps of attempts in the current window. */
  timestamps: number[];
}

/** Recovery code tracking for the memory store. */
interface MemoryRecoveryCodes {
  /** The SHA-256 hex digests of the recovery codes. */
  digests: string[];
  /** Which indices have been consumed. */
  consumed: boolean[];
}

/**
 * In-memory implementation of {@linkcode ITotpStore}.
 *
 * For tests and single-process development. All operations are synchronous
 * internally but exposed through the async port so a remote backend can be
 * substituted without a breaking change. No constructor arguments: the store
 * needs no clock, because callers pass `now` to {@linkcode ITotpStore.reserveAttempt}.
 */
export class MemoryTotpStore implements ITotpStore {
  #enrolments = new Map<string, TotpEnrolment>();
  #attempts = new Map<string, MemoryAttempts>();
  #recoveryCodes = new Map<string, MemoryRecoveryCodes>();

  getEnrolment(principalId: string): Promise<TotpEnrolment | null> {
    const record = this.#enrolments.get(principalId);
    if (record === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ ...record });
  }

  saveEnrolment(principalId: string, enrolment: TotpEnrolment): Promise<void> {
    this.#enrolments.set(principalId, { ...enrolment });
    return Promise.resolve();
  }

  deleteEnrolment(principalId: string): Promise<void> {
    this.#enrolments.delete(principalId);
    this.#attempts.delete(principalId);
    this.#recoveryCodes.delete(principalId);
    return Promise.resolve();
  }

  claimStep(principalId: string, step: number): Promise<boolean> {
    const record = this.#enrolments.get(principalId);
    if (record === undefined) {
      return Promise.resolve(false);
    }
    if (step <= record.lastClaimedStep) {
      return Promise.resolve(false);
    }
    record.lastClaimedStep = step;
    return Promise.resolve(true);
  }

  reserveAttempt(
    principalId: string,
    now: number,
    options: { readonly limit: number; readonly windowMs: number },
  ): Promise<ReserveAttemptResult> {
    let attempts = this.#attempts.get(principalId);
    if (attempts === undefined) {
      attempts = { timestamps: [] };
      this.#attempts.set(principalId, attempts);
    }
    const cutoff = now - options.windowMs;
    attempts.timestamps = attempts.timestamps.filter((ts) => ts > cutoff);
    if (attempts.timestamps.length >= options.limit) {
      // Refused, and deliberately not recorded: see ITotpStore.reserveAttempt.
      return Promise.resolve({ allowed: false, count: attempts.timestamps.length + 1 });
    }
    attempts.timestamps.push(now);
    return Promise.resolve({ allowed: true, count: attempts.timestamps.length });
  }

  clearAttempts(principalId: string): Promise<void> {
    this.#attempts.delete(principalId);
    return Promise.resolve();
  }

  saveRecoveryCodes(principalId: string, digests: readonly string[]): Promise<void> {
    this.#recoveryCodes.set(principalId, {
      digests: [...digests],
      consumed: new Array(digests.length).fill(false),
    });
    return Promise.resolve();
  }

  consumeRecoveryCode(principalId: string, digest: string): Promise<boolean> {
    const record = this.#recoveryCodes.get(principalId);
    if (record === undefined) {
      return Promise.resolve(false);
    }
    const index = record.digests.indexOf(digest);
    if (index === -1) {
      return Promise.resolve(false);
    }
    if (record.consumed[index]) {
      return Promise.resolve(false);
    }
    record.consumed[index] = true;
    return Promise.resolve(true);
  }
}
