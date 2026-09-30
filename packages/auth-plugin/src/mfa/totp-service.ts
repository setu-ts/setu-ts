/**
 * TOTP service — enrolment, verification, recovery codes, and sign-in
 * completion. Application-instantiated (the `RefreshTokenService` precedent):
 * the code form is application UI; the service owns every rule that must not
 * vary.
 *
 * `completeSignIn` and `completeSignInWithRecoveryCode` are the only sign-in
 * path: each reads the pending principal from the `AUTH_SESSION` capability,
 * verifies the code for THAT principal (never a caller-supplied id), and
 * promotes on success. The principal-id methods above serve enrolment and
 * settings pages.
 *
 * @module
 */

import type {
  IAuthSessionService,
  IRequestContext,
  IRuntimeServices,
  ISessionService,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import type { ITotpStore } from '../stores/totp-store.ts';
import { toBuffer } from '../utils/buffer.ts';
import { decodeBase32, encodeBase32 } from './base32.ts';
import { TOTP_DIGITS, TOTP_PERIOD_SECONDS, totpCounter } from './totp-codes.ts';
import { promotePending } from '../sign-in/auth-session-service.ts';

/** Options for constructing a {@linkcode TotpService}. */
export interface TotpServiceOptions {
  /** The store backing TOTP enrolment, step claims, lockout, and recovery codes. */
  readonly store: ITotpStore;
  /** Runtime services for random bytes, clock, and Web Crypto. */
  readonly runtime: IRuntimeServices;
  /** The issuer name shown in the authenticator app. */
  readonly issuer: string;
  /**
   * How long a pending second-factor record may sit before it is refused, in
   * milliseconds. Defaults to 300 000 (5 minutes).
   */
  readonly pendingTtlMs?: number;
}

/** The result of a TOTP code verification. */
export type TotpVerifyResult = 'ok' | 'invalid' | 'locked' | 'not-enrolled';

/** The result of a recovery-code verification. */
export type RecoveryVerifyResult = 'ok' | 'invalid' | 'locked';

/** The result of completing a sign-in with a second factor. */
export type TotpCompleteSignInResult =
  | 'signed-in'
  | 'invalid'
  | 'locked'
  | 'not-enrolled'
  | 'no-pending';

/** Lockout parameters: 5 attempts in 15 minutes. */
const LOCKOUT_LIMIT = 5;
const LOCKOUT_WINDOW_MS = 900_000;

/** Number of recovery codes generated per set. */
const RECOVERY_CODE_COUNT = 10;

/** Bytes of entropy per recovery code (10 bytes → 16 base32 chars → 80 bits). */
const RECOVERY_CODE_BYTES = 10;

/** Default pending sign-in TTL in milliseconds (5 minutes). */
const DEFAULT_PENDING_TTL_MS = 300_000;

/**
 * TOTP service for enrolment, verification, recovery codes, and sign-in
 * completion.
 *
 * The application instantiates this service and calls its methods from route
 * handlers. The `completeSignIn` and `completeSignInWithRecoveryCode` methods
 * are the only sign-in path: they read the pending principal from the
 * `AUTH_SESSION` capability, verify the code for that principal, and promote
 * on success.
 */
export class TotpService {
  #store: ITotpStore;
  #runtime: IRuntimeServices;
  #issuer: string;
  #pendingTtlMs: number;

  /**
   * @param options - Store, runtime, issuer, and pending-record TTL
   */
  constructor(options: TotpServiceOptions) {
    this.#store = options.store;
    this.#runtime = options.runtime;
    this.#issuer = options.issuer;
    this.#pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
  }

  /**
   * Begins a TOTP enrolment for a principal.
   *
   * Generates a 20-byte secret, encodes it as base32 (RFC 4648, no padding),
   * and builds the `otpauth://` URI for the authenticator app. The enrolment
   * is stored unconfirmed; it becomes active after {@linkcode confirmEnrolment}.
   *
   * @param principalId - The principal to enrol
   * @param label - The label shown in the authenticator app (usually the user's email)
   * @returns The base32 secret and the `otpauth://` URI
   */
  async beginEnrolment(principalId: string, label: string): Promise<{
    readonly secret: string;
    readonly uri: string;
  }> {
    const raw = this.#runtime.randomBytes(20);
    const secret = encodeBase32(raw);
    const uri = `otpauth://totp/${encodeURIComponent(this.#issuer)}:${encodeURIComponent(label)}` +
      `?secret=${secret}&issuer=${encodeURIComponent(this.#issuer)}` +
      `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
    await this.#store.saveEnrolment(principalId, {
      secret,
      label,
      confirmed: false,
      lastClaimedStep: 0,
    });
    return { secret, uri };
  }

  /**
   * Confirms a TOTP enrolment with a valid code.
   *
   * The first valid code confirms the enrolment, making it active for
   * subsequent verifications.
   *
   * @param principalId - The principal whose enrolment is confirmed
   * @param code - The six-digit code from the authenticator app
   * @returns The verification result
   */
  async confirmEnrolment(principalId: string, code: string): Promise<TotpVerifyResult> {
    const result = await this.verify(principalId, code);
    if (result === 'ok') {
      const enrolment = await this.#store.getEnrolment(principalId);
      if (enrolment !== null && !enrolment.confirmed) {
        await this.#store.saveEnrolment(principalId, { ...enrolment, confirmed: true });
      }
    }
    return result;
  }

  /**
   * Verifies a TOTP code for a principal.
   *
   * Checks lockout first (5 attempts in 15 minutes), then verifies the code
   * against the current step and ±1. A valid code claims its step (preventing
   * replay) and clears the attempt count.
   *
   * @param principalId - The principal to verify for
   * @param code - The six-digit code
   * @returns The verification result
   */
  async verify(principalId: string, code: string): Promise<TotpVerifyResult> {
    const now = this.#runtime.now();
    const attempt = await this.#store.reserveAttempt(principalId, now, {
      limit: LOCKOUT_LIMIT,
      windowMs: LOCKOUT_WINDOW_MS,
    });
    if (!attempt.allowed) {
      return 'locked';
    }

    const enrolment = await this.#store.getEnrolment(principalId);
    if (enrolment === null) {
      return 'not-enrolled';
    }

    let secret: Uint8Array;
    try {
      secret = decodeBase32(enrolment.secret);
    } catch {
      return 'invalid';
    }
    const current = totpCounter(now);

    for (let delta = -1; delta <= 1; delta++) {
      const step = current + delta;
      const candidate = await this.#computeCode(secret, step);
      if (this.#constantTimeEquals(candidate, code)) {
        const claimed = await this.#store.claimStep(principalId, step);
        if (!claimed) {
          return 'invalid';
        }
        await this.#store.clearAttempts(principalId);
        return 'ok';
      }
    }
    return 'invalid';
  }

  /**
   * Generates ten recovery codes for a principal.
   *
   * Each code is 10 random bytes encoded as 16 base32 characters (80 bits).
   * The codes are stored as SHA-256 digests; the plaintext codes are returned
   * once and never stored.
   *
   * @param principalId - The principal to generate codes for
   * @returns The ten plaintext recovery codes
   */
  async generateRecoveryCodes(principalId: string): Promise<string[]> {
    const codes: string[] = [];
    const digests: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const raw = this.#runtime.randomBytes(RECOVERY_CODE_BYTES);
      const code = encodeBase32(raw);
      codes.push(code);
      const digest = await this.#runtime.subtle.digest('SHA-256', toBuffer(raw));
      digests.push(bytesToHex(new Uint8Array(digest)));
    }
    await this.#store.saveRecoveryCodes(principalId, digests);
    return codes;
  }

  /**
   * Verifies and consumes a recovery code.
   *
   * Checks lockout first, then computes the SHA-256 digest of the code and
   * atomically consumes it through the store. A match clears the attempt
   * count.
   *
   * @param principalId - The principal to verify for
   * @param code - The recovery code
   * @returns The verification result
   */
  async verifyRecoveryCode(principalId: string, code: string): Promise<RecoveryVerifyResult> {
    const now = this.#runtime.now();
    const attempt = await this.#store.reserveAttempt(principalId, now, {
      limit: LOCKOUT_LIMIT,
      windowMs: LOCKOUT_WINDOW_MS,
    });
    if (!attempt.allowed) {
      return 'locked';
    }

    // Decode the base32 code back to raw bytes so the digest matches the one
    // stored by `generateRecoveryCodes` (which hashes the raw bytes, not the
    // base32 string). A code with characters outside the base32 alphabet is
    // simply not a valid recovery code.
    let raw: Uint8Array;
    try {
      raw = decodeBase32(code);
    } catch {
      return 'invalid';
    }
    const digestBytes = await this.#runtime.subtle.digest('SHA-256', toBuffer(raw));
    const digest = bytesToHex(new Uint8Array(digestBytes));

    const consumed = await this.#store.consumeRecoveryCode(principalId, digest);
    if (!consumed) {
      return 'invalid';
    }
    await this.#store.clearAttempts(principalId);
    return 'ok';
  }

  /**
   * Disables TOTP for a principal, deleting the enrolment, recovery codes,
   * and attempt counts.
   *
   * @param principalId - The principal to disable TOTP for
   */
  async disable(principalId: string): Promise<void> {
    await this.#store.deleteEnrolment(principalId);
  }

  /**
   * Completes a pending sign-in with a TOTP code.
   *
   * Reads the pending principal from the `AUTH_SESSION` capability, verifies
   * the code for THAT principal (never a caller-supplied id), and promotes
   * the pending record to the signed-in key on success.
   *
   * @param ctx - The request context
   * @param code - The six-digit TOTP code
   * @returns The completion result
   */
  async completeSignIn(ctx: IRequestContext, code: string): Promise<TotpCompleteSignInResult> {
    const authSession = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
    const pending = authSession.pending(ctx);
    if (pending === null) {
      return 'no-pending';
    }

    const result = await this.verify(pending.principal.id, code);
    if (result !== 'ok') {
      return result;
    }

    const sessionService = ctx.services.get<ISessionService>(CAPABILITIES.SESSION);
    const outcome = promotePending(ctx, 'otp', {
      sessionService,
      now: () => this.#runtime.now(),
      pendingTtlMs: this.#pendingTtlMs,
    });
    if (outcome !== 'signed-in') {
      return 'no-pending';
    }
    return 'signed-in';
  }

  /**
   * Completes a pending sign-in with a recovery code.
   *
   * Reads the pending principal from the `AUTH_SESSION` capability, verifies
   * and consumes the recovery code for THAT principal, and promotes the
   * pending record to the signed-in key on success.
   *
   * A recovery code completes the second factor with method `'otp'`: RFC 8176
   * registers no recovery-code value, so a policy cannot tell the two apart.
   *
   * @param ctx - The request context
   * @param code - The recovery code
   * @returns The completion result
   */
  async completeSignInWithRecoveryCode(
    ctx: IRequestContext,
    code: string,
  ): Promise<TotpCompleteSignInResult> {
    const authSession = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
    const pending = authSession.pending(ctx);
    if (pending === null) {
      return 'no-pending';
    }

    const result = await this.verifyRecoveryCode(pending.principal.id, code);
    if (result !== 'ok') {
      return result === 'locked' ? 'locked' : 'invalid';
    }

    const sessionService = ctx.services.get<ISessionService>(CAPABILITIES.SESSION);
    const outcome = promotePending(ctx, 'otp', {
      sessionService,
      now: () => this.#runtime.now(),
      pendingTtlMs: this.#pendingTtlMs,
    });
    if (outcome !== 'signed-in') {
      return 'no-pending';
    }
    return 'signed-in';
  }

  /** Computes a TOTP code for a given step. */
  async #computeCode(secret: Uint8Array, step: number): Promise<string> {
    const key = await this.#runtime.subtle.importKey(
      'raw',
      toBuffer(secret),
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign'],
    );
    const counterBytes = new Uint8Array(8);
    let value = step;
    for (let i = 7; i >= 0; i--) {
      counterBytes[i] = value & 0xff;
      value = Math.floor(value / 256);
    }
    const hmac = new Uint8Array(await this.#runtime.subtle.sign('HMAC', key, counterBytes));
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary = ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);
    const otp = binary % 10 ** TOTP_DIGITS;
    return otp.toString().padStart(TOTP_DIGITS, '0');
  }

  /** Constant-time string comparison. */
  #constantTimeEquals(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }
}

/** Converts a byte array to a lowercase hex string. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
