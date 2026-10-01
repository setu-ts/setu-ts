/**
 * TOTP service — enrolment, verification, recovery codes, and sign-in
 * completion. Application-instantiated (the `RefreshTokenService` precedent):
 * the code form is application UI; the service owns every rule that must not
 * vary.
 *
 * `completeSignIn` and `completeSignInWithRecoveryCode` are the only sign-in
 * path: each reads the pending principal from the `AUTH_SESSION` capability,
 * verifies the code for THAT principal (never a caller-supplied id), and asks
 * the auth-session service to promote the pending record. The pending-record
 * TTL belongs to `signIn.mfa.pendingTtlMs` alone — this service has no TTL
 * option of its own.
 *
 * @module
 */

import type { IAuthSessionService, IRequestContext, IRuntimeServices } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import type { ITotpStore } from '../stores/totp-store.ts';
import { asPendingPromotion } from '../sign-in/auth-session-service.ts';
import { toBuffer } from '../utils/buffer.ts';
import { decodeBase32, encodeBase32 } from './base32.ts';
import {
  computeTotpCode,
  constantTimeEquals,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_WINDOW,
  totpCounter,
} from './totp-codes.ts';

/** Options for constructing a {@linkcode TotpService}. */
export interface TotpServiceOptions {
  /** The store backing TOTP enrolment, step claims, lockout, and recovery codes. */
  readonly store: ITotpStore;
  /** Runtime services for random bytes, clock, and Web Crypto. */
  readonly runtime: IRuntimeServices;
  /** The issuer name shown in the authenticator app. */
  readonly issuer: string;
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

/**
 * A recovery code is exactly this many base32 characters, and exactly this many
 * bytes when decoded. Both are asserted before the code is hashed, so a longer
 * string that merely CONTAINS a valid code cannot verify: `decodeBase32` drops
 * leftover bits, so 17 characters can decode to the same 10 bytes as 16.
 */
const RECOVERY_CODE_CHARS = 16;
const RECOVERY_CODE_DECODED_BYTES = 10;

/** A recovery code as the user is expected to type it: 16 base32 characters. */
const RECOVERY_CODE_SHAPE = /^[A-Z2-7]{16}$/;

/**
 * TOTP service for enrolment, verification, recovery codes, and sign-in
 * completion.
 *
 * The application instantiates this service and calls its methods from route
 * handlers. The `completeSignIn` and `completeSignInWithRecoveryCode` methods
 * are the only sign-in path: they read the pending principal from the
 * `AUTH_SESSION` capability, verify the code for that principal, and promote
 * the pending record through the auth-session service.
 */
export class TotpService {
  #store: ITotpStore;
  #runtime: IRuntimeServices;
  #issuer: string;

  /**
   * Builds the service over a store, a runtime, and the issuer name an
   * authenticator app will display.
   *
   * @param options - The enrolment store, the runtime services, and the issuer
   */
  constructor(options: TotpServiceOptions) {
    this.#store = options.store;
    this.#runtime = options.runtime;
    this.#issuer = options.issuer;
  }

  /**
   * Begins a TOTP enrolment for a principal.
   *
   * Generates a 20-byte secret, encodes it as base32 (RFC 4648, no padding),
   * and builds the `otpauth://` URI for the authenticator app.
   *
   * A principal with NO confirmed factor stores the new secret as the
   * unconfirmed one. A principal who already has a confirmed factor gets the new
   * secret stored as a PENDING secret: the proven secret keeps verifying, and
   * `lastClaimedStep` keeps its value, until {@linkcode confirmEnrolment}
   * presents a code from the new secret. Beginning an enrolment therefore cannot
   * silently replace a working factor with an unproven one, and cannot reopen
   * the replay of an already-claimed step.
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
    const existing = await this.#store.getEnrolment(principalId);
    if (existing !== null && existing.confirmed) {
      // A confirmed factor stays in force; the new secret waits for confirmation.
      await this.#store.saveEnrolment(principalId, {
        secret: existing.secret,
        label: existing.label,
        confirmed: true,
        lastClaimedStep: existing.lastClaimedStep,
        pendingSecret: secret,
        pendingLabel: label,
      });
    } else {
      await this.#store.saveEnrolment(principalId, {
        secret,
        label,
        confirmed: false,
        lastClaimedStep: existing?.lastClaimedStep ?? 0,
      });
    }
    return { secret, uri };
  }

  /**
   * Confirms a TOTP enrolment with a valid code.
   *
   * The code must come from the secret awaiting confirmation — the pending one
   * when a re-enrolment is in progress, otherwise the stored one. On success the
   * pending secret becomes the active secret, the enrolment becomes confirmed,
   * and `lastClaimedStep` is carried over unchanged, so a step claimed under the
   * old secret stays claimed.
   *
   * @param principalId - The principal whose enrolment is confirmed
   * @param code - The six-digit code from the authenticator app
   * @returns The verification result
   */
  async confirmEnrolment(principalId: string, code: string): Promise<TotpVerifyResult> {
    const result = await this.#verifyCode(principalId, code, true);
    if (result !== 'ok') {
      return result;
    }
    // Re-read: claiming the step mutated the stored record.
    const enrolment = await this.#store.getEnrolment(principalId);
    if (enrolment === null) {
      return 'not-enrolled';
    }
    await this.#store.saveEnrolment(principalId, {
      secret: enrolment.pendingSecret ?? enrolment.secret,
      label: enrolment.pendingLabel ?? enrolment.label,
      confirmed: true,
      lastClaimedStep: enrolment.lastClaimedStep,
    });
    return 'ok';
  }

  /**
   * Verifies a TOTP code for a principal.
   *
   * Checks lockout first (5 attempts in 15 minutes), then verifies the code
   * against the current step and ±{@linkcode TOTP_WINDOW}. A valid code claims
   * its step (preventing replay) and clears the attempt count.
   *
   * Only a CONFIRMED factor verifies. An enrolment that was begun and never
   * confirmed answers `'not-enrolled'`: an unconfirmed secret has never been
   * shown to reach the user's authenticator, so it is not yet a factor the
   * framework will sign anyone in with. {@linkcode confirmEnrolment} is the one
   * path that accepts an unconfirmed secret, and it is what confirms it.
   *
   * @param principalId - The principal to verify for
   * @param code - The six-digit code
   * @returns The verification result
   */
  verify(principalId: string, code: string): Promise<TotpVerifyResult> {
    return this.#verifyCode(principalId, code, false);
  }

  /**
   * The one code-verification implementation.
   *
   * @param principalId - The principal to verify for
   * @param code - The six-digit code
   * @param allowUnconfirmed - When `true`, the secret awaiting confirmation is
   *   the one tried, and an unconfirmed enrolment is not refused. Only
   *   {@linkcode confirmEnrolment} passes `true`.
   */
  async #verifyCode(
    principalId: string,
    code: string,
    allowUnconfirmed: boolean,
  ): Promise<TotpVerifyResult> {
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
    if (!allowUnconfirmed && !enrolment.confirmed) {
      // A factor the user has never confirmed is not a factor yet.
      return 'not-enrolled';
    }
    const secretText = allowUnconfirmed
      ? (enrolment.pendingSecret ?? enrolment.secret)
      : enrolment.secret;

    let secret: Uint8Array;
    try {
      secret = decodeBase32(secretText);
    } catch {
      return 'invalid';
    }
    const current = totpCounter(now);

    for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
      const step = current + delta;
      const candidate = await computeTotpCode(this.#runtime.subtle, secret, step);
      if (constantTimeEquals(candidate, code)) {
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
   * atomically consumes it through the store. A match clears the attempt count.
   *
   * The accepted form is the generated one, in any letter case and with any
   * surrounding whitespace: the code is trimmed and upper-cased, then must be
   * exactly 16 characters of the base32 alphabet. Anything else — a shorter
   * string, a character outside `A-Z2-7`, or a valid code with extra characters
   * appended — answers `'invalid'` without consulting the store. That strictness
   * matters: `decodeBase32` drops leftover bits, so a 17-character string can
   * decode to the same bytes as the 16-character code inside it.
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

    // Normalise, then require the exact canonical shape BEFORE decoding: a
    // decoded-length check would still accept a code with trailing characters.
    const normalised = code.trim().toUpperCase();
    if (
      normalised.length !== RECOVERY_CODE_CHARS ||
      !RECOVERY_CODE_SHAPE.test(normalised)
    ) {
      return 'invalid';
    }
    // Decode the base32 code back to raw bytes so the digest matches the one
    // stored by `generateRecoveryCodes` (which hashes the raw bytes, not the
    // base32 string).
    let raw: Uint8Array;
    try {
      raw = decodeBase32(normalised);
    } catch {
      return 'invalid';
    }
    if (raw.length !== RECOVERY_CODE_DECODED_BYTES) {
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
   * the code for THAT principal (never a caller-supplied id), and asks the
   * auth-session service to promote the pending record to the signed-in key. An
   * unconfirmed enrolment answers `'not-enrolled'`: see {@linkcode verify}.
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

    const promotion = asPendingPromotion(authSession);
    if (promotion === null) {
      // A service that will not promote its own pending record cannot complete
      // a sign-in: promotion and its TTL belong to the auth-session service.
      return 'no-pending';
    }
    return promotion.promotePending(ctx, 'otp');
  }

  /**
   * Completes a pending sign-in with a recovery code.
   *
   * Reads the pending principal from the `AUTH_SESSION` capability, verifies
   * and consumes the recovery code for THAT principal, and asks the
   * auth-session service to promote the pending record to the signed-in key.
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

    const promotion = asPendingPromotion(authSession);
    if (promotion === null) {
      return 'no-pending';
    }
    return promotion.promotePending(ctx, 'otp');
  }
}

/** Converts a byte array to a lowercase hex string. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
