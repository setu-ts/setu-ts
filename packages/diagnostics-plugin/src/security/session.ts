/**
 * Session state: key material, instance binding, monotonic expiry, sequence
 * monotonicity, and revocation.
 *
 * The ATOMIC GATE is the point of this module. Every step between
 * `subtle.verify` resolving and diagnostics being read is a plain
 * synchronous check-and-advance — {@linkcode DiagnosticsSessionState.admitAfterVerify}
 * yields to nothing, so two racing or replayed requests cannot both pass it,
 * and a revocation that lands during an await is caught by the same
 * synchronous re-check on the response path.
 *
 * @module
 */

import { importSessionKey, signFields, verifyFields } from './authentication.ts';

/**
 * The clock the session runs on: the runtime's monotonic `hrtime()`. Never
 * wall-clock time — an attacker who can set the wall clock cannot extend a
 * session, and a suspended laptop does not expire one arbitrarily.
 *
 * @internal
 */
export interface SessionClock {
  /** Returns monotonic milliseconds. */
  hrtime(): number;
}

/**
 * The maximum sequence number a session accepts. Reaching it ends the
 * session rather than wrapping.
 *
 * @internal
 */
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;

/**
 * One paired native-client session.
 *
 * Created at activation with the launch's credentials; keyed material lives
 * in a non-extractable `CryptoKey`. Exactly one session exists per connector
 * instance, and it binds to exactly one application-instance UUID through
 * the first successful signed status exchange.
 *
 * @internal
 */
export class DiagnosticsSessionState {
  #subtle: SubtleCrypto;
  #key: CryptoKey | null;
  readonly sessionId: string;
  readonly #expiresAtHr: number;
  readonly #ttlMs: number;
  #instanceId: string | null = null;
  #highestSequence = 0;
  #revoked = false;

  private constructor(
    subtle: SubtleCrypto,
    key: CryptoKey,
    sessionId: string,
    ttlMs: number,
    expiresAtHr: number,
  ) {
    this.#subtle = subtle;
    this.#key = key;
    this.sessionId = sessionId;
    this.#ttlMs = ttlMs;
    this.#expiresAtHr = expiresAtHr;
  }

  /**
   * Creates and activates a session: imports the raw key (zeroing the
   * temporary copy) and starts the monotonic expiry window.
   *
   * @param subtle - The Web Crypto SubtleCrypto to use
   * @param sessionId - The launch's session ID
   * @param sessionKey - The launch's 32-byte session key
   * @param ttlMs - Lifetime in milliseconds
   * @param clock - The monotonic clock
   * @returns The active session
   */
  static async create(
    subtle: SubtleCrypto,
    sessionId: string,
    sessionKey: Uint8Array,
    ttlMs: number,
    clock: SessionClock,
  ): Promise<DiagnosticsSessionState> {
    const key = await importSessionKey(subtle, sessionKey);
    return new DiagnosticsSessionState(
      subtle,
      key,
      sessionId,
      ttlMs,
      clock.hrtime() + ttlMs,
    );
  }

  /**
   * Whether the session is bound to an application instance yet.
   *
   * @returns `true` once a status exchange has bound the instance UUID
   */
  hasInstance(): boolean {
    return this.#instanceId !== null;
  }

  /**
   * The bound application-instance UUID, or `null` before the first
   * successful status exchange.
   *
   * @returns The bound UUID or `null`
   */
  get instanceId(): string | null {
    return this.#instanceId;
  }

  /**
   * Binds the session to an application-instance UUID. Only the first
   * successful status exchange may bind; later calls with a different UUID
   * are refused by the caller's checks and leave the binding untouched.
   *
   * @param instanceId - The non-null instance UUID from M98a's snapshot
   */
  bindInstance(instanceId: string): void {
    if (this.#instanceId === null) {
      this.#instanceId = instanceId;
    }
  }

  /**
   * The session's remaining lifetime in whole milliseconds, never negative.
   *
   * @param clock - The monotonic clock
   * @returns Remaining milliseconds
   */
  remainingMs(clock: SessionClock): number {
    return Math.max(0, this.#expiresAtHr - clock.hrtime());
  }

  /**
   * The configured lifetime in milliseconds.
   *
   * @returns The TTL the session was created with
   */
  get ttlMs(): number {
    return this.#ttlMs;
  }

  /**
   * Whether the session is still authorized — not revoked, not expired.
   * This is the POST-AWAIT response gate: called again after every
   * asynchronous step (including after the signed bytes are built), so a
   * response in flight at revocation is discarded rather than releasing
   * diagnostic data.
   *
   * @param clock - The monotonic clock
   * @returns `true` while the session may serve
   */
  isAdmissible(clock: SessionClock): boolean {
    return !this.#revoked && clock.hrtime() < this.#expiresAtHr;
  }

  /**
   * THE atomic gate, called after `subtle.verify` resolves. Re-checks
   * revocation and monotonic expiry, then advances the highest accepted
   * sequence — synchronously, with no await between the checks and the
   * advance, so a replayed or racing request cannot interleave and both
   * pass.
   *
   * Sequence exhaustion ends the session: once
   * {@linkcode MAX_SEQUENCE} is reached, no further sequence can pass.
   *
   * @param sequence - The request's parsed sequence number
   * @param clock - The monotonic clock
   * @returns `true` when the request may proceed to read diagnostics
   */
  admitAfterVerify(sequence: number, clock: SessionClock): boolean {
    if (this.#revoked || clock.hrtime() >= this.#expiresAtHr) {
      return false;
    }
    if (this.#highestSequence >= MAX_SEQUENCE) {
      return false;
    }
    if (sequence <= this.#highestSequence) {
      return false;
    }
    this.#highestSequence = sequence;
    return true;
  }

  /**
   * Whether the session still holds usable key material for a verification
   * attempt. A revoked session refuses BEFORE crypto.
   *
   * @returns `true` while verification may be attempted
   */
  canVerify(): boolean {
    return !this.#revoked && this.#key !== null;
  }

  /**
   * Verifies a MAC over canonical fields with the session key. Refuses
   * without touching crypto once revoked.
   *
   * @param fields - The canonical fields, in order
   * @param macHex - The presented MAC header value
   * @returns `true` only when the MAC verifies
   */
  async verify(fields: readonly string[], macHex: string): Promise<boolean> {
    const key = this.#key;
    if (this.#revoked || key === null) {
      return false;
    }
    return await verifyFields(this.#subtle, key, macHex, fields);
  }

  /**
   * Signs canonical fields with the session key. Refuses once revoked.
   *
   * @param fields - The canonical fields, in order
   * @returns The lowercase hex MAC, or `null` when revoked
   */
  async sign(fields: readonly string[]): Promise<string | null> {
    const key = this.#key;
    if (this.#revoked || key === null) {
      return null;
    }
    return await signFields(this.#subtle, key, fields);
  }

  /**
   * Revokes the session: disables authorization and drops the key
   * reference. Idempotent. A revoked session can never be reactivated —
   * pairing again requires a fresh launch.
   */
  revoke(): void {
    this.#revoked = true;
    this.#key = null;
  }
}
