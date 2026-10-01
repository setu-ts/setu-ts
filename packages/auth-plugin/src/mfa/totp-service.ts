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

/**
 * The result of a factor-changing call that needs proof of the CURRENT factor:
 * confirming a re-enrolment, regenerating recovery codes, or disabling.
 *
 * - `'proof-required'` — a confirmed factor exists and no proof was supplied.
 * - `'invalid'` / `'locked'` — the proof (or, for a confirmation, the new code)
 *   failed, or the account is locked out.
 * - `'not-enrolled'` — there is no factor to act on.
 */
export type TotpProofResult = 'proof-required' | 'invalid' | 'locked' | 'not-enrolled';

/**
 * The result of {@linkcode TotpService.confirmEnrolment}: on success, the ten
 * recovery codes minted for the newly confirmed factor, returned this once.
 */
export type ConfirmEnrolmentResult =
  | { readonly status: 'ok'; readonly recoveryCodes: readonly string[] }
  | { readonly status: TotpProofResult };

/** The result of {@linkcode TotpService.generateRecoveryCodes}. */
export type RecoveryCodesResult =
  | { readonly status: 'ok'; readonly recoveryCodes: readonly string[] }
  | { readonly status: TotpProofResult };

/** The result of {@linkcode TotpService.disable}. */
export type DisableResult = 'ok' | TotpProofResult;

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

/** A TOTP code: exactly six digits. Anything else offered as proof is a recovery code. */
const TOTP_CODE_SHAPE = /^\d{6}$/;

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
    // One atomic store operation, never a read followed by a whole-record write:
    // a write-back racing a sign-in's step claim would roll the claimed step back.
    await this.#store.stageSecret(principalId, secret, label);
    return { secret, uri };
  }

  /**
   * Confirms a TOTP enrolment with a valid code from the secret awaiting
   * confirmation, and mints the principal's recovery codes.
   *
   * A FIRST enrolment (no confirmed factor yet) needs only the new code. A
   * RE-enrolment — a confirmed factor exists and {@linkcode beginEnrolment}
   * stored a pending secret — also needs `proof` of the CURRENT factor: a code
   * from it or an unused recovery code. Without that rule anyone able to call
   * this with a principal id could swap in their own authenticator and take the
   * account's second factor; with it, replacing a factor takes the factor.
   *
   * On success the pending secret becomes the active one, `lastClaimedStep`
   * stays monotonic across the swap, and a fresh set of ten recovery codes
   * REPLACES any earlier set — so recovery codes only ever exist for a proven
   * factor. The plaintext codes are returned this once.
   *
   * Called for a confirmed factor with NO re-enrolment pending, `code` is
   * checked against the confirmed secret, so it is itself the proof; that call
   * re-mints the recovery codes.
   *
   * @param principalId - The principal whose enrolment is confirmed
   * @param code - A six-digit code from the secret awaiting confirmation
   * @param proof - For a re-enrolment, a code from the current factor or an
   *   unused recovery code
   * @returns The recovery codes on success, otherwise why it was refused
   */
  async confirmEnrolment(
    principalId: string,
    code: string,
    proof?: string,
  ): Promise<ConfirmEnrolmentResult> {
    const existing = await this.#store.getEnrolment(principalId);
    if (existing === null) {
      return { status: 'not-enrolled' };
    }
    const replacing = existing.confirmed && existing.pendingSecret !== undefined;
    if (replacing && proof === undefined) {
      // Re-enrolment: the current factor must be proven before anything moves.
      return { status: 'proof-required' };
    }
    // The secret this code is checked against: the one awaiting confirmation,
    // or — for a confirmed factor with nothing pending — the factor itself, in
    // which case the code is its own proof and the call re-mints the codes.
    const awaiting = existing.pendingSecret ?? existing.secret;

    // The NEW code is checked first, so a mistyped one does not spend a
    // recovery code offered as proof.
    const step = await this.#matchStep(principalId, awaiting, code);
    if (typeof step !== 'number') {
      return { status: step };
    }
    if (replacing) {
      const proven = await this.#verifyProof(principalId, proof ?? '');
      if (proven !== 'ok') {
        return { status: proven };
      }
    } else if (!(await this.#store.claimStep(principalId, step))) {
      // The code's step is already spent: a replay.
      return { status: 'invalid' };
    }
    await this.#store.clearAttempts(principalId);

    if (!existing.confirmed || replacing) {
      // Atomic, and only if `awaiting` is STILL the staged secret: a secret
      // staged concurrently must not be confirmed on the strength of this code.
      if (!(await this.#store.confirmSecret(principalId, awaiting, step))) {
        return { status: 'invalid' };
      }
    }
    return { status: 'ok', recoveryCodes: await this.#mintRecoveryCodes(principalId) };
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
  async verify(principalId: string, code: string): Promise<TotpVerifyResult> {
    // Lockout first: a locked principal is refused before its record is read or
    // any code is computed.
    if (!(await this.#reserve(principalId))) {
      return 'locked';
    }
    const enrolment = await this.#store.getEnrolment(principalId);
    if (enrolment === null || !enrolment.confirmed) {
      // A factor the user has never confirmed is not a factor yet.
      return 'not-enrolled';
    }
    const step = await this.#findStep(enrolment.secret, code);
    if (step === null || !(await this.#store.claimStep(principalId, step))) {
      return 'invalid';
    }
    await this.#store.clearAttempts(principalId);
    return 'ok';
  }

  /**
   * Checks a code against a secret, counting the attempt toward lockout,
   * without claiming a step or clearing the count: the caller decides what the
   * matched step means. Returns the matched step, or why it was refused.
   */
  async #matchStep(
    principalId: string,
    secretText: string,
    code: string,
  ): Promise<number | 'invalid' | 'locked'> {
    if (!(await this.#reserve(principalId))) {
      return 'locked';
    }
    return (await this.#findStep(secretText, code)) ?? 'invalid';
  }

  /** Reserves one attempt against the lockout; `false` when locked out. */
  async #reserve(principalId: string): Promise<boolean> {
    const attempt = await this.#store.reserveAttempt(principalId, this.#runtime.now(), {
      limit: LOCKOUT_LIMIT,
      windowMs: LOCKOUT_WINDOW_MS,
    });
    return attempt.allowed;
  }

  /**
   * The one code-matching implementation: the step within the ±1 window whose
   * code equals `code` (compared in constant time), or `null`. An undecodable
   * secret matches nothing, and so does a non-string code: the comparison's
   * length check refuses it.
   */
  async #findStep(secretText: string, code: string): Promise<number | null> {
    let secret: Uint8Array;
    try {
      secret = decodeBase32(secretText);
    } catch {
      return null;
    }
    const current = totpCounter(this.#runtime.now());
    for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
      const candidate = await computeTotpCode(this.#runtime.subtle, secret, current + delta);
      if (constantTimeEquals(candidate, code)) {
        return current + delta;
      }
    }
    return null;
  }

  /**
   * Verifies proof of a principal's CURRENT factor: a six-digit code from the
   * confirmed secret, otherwise an unused recovery code (consumed). Both paths
   * count toward the same lockout.
   */
  async #verifyProof(
    principalId: string,
    proof: string,
  ): Promise<'ok' | 'invalid' | 'locked' | 'not-enrolled'> {
    // A non-string (a JSON body can carry anything) needs no guard here: both
    // verifiers answer 'invalid' for one, which the tests pin.
    return TOTP_CODE_SHAPE.test(proof)
      ? await this.verify(principalId, proof)
      : await this.verifyRecoveryCode(principalId, proof);
  }

  /** Mints and stores ten recovery codes, replacing any earlier set. */
  async #mintRecoveryCodes(principalId: string): Promise<string[]> {
    const codes: string[] = [];
    const digests: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const raw = this.#runtime.randomBytes(RECOVERY_CODE_BYTES);
      codes.push(encodeBase32(raw));
      const digest = await this.#runtime.subtle.digest('SHA-256', toBuffer(raw));
      digests.push(bytesToHex(new Uint8Array(digest)));
    }
    await this.#store.saveRecoveryCodes(principalId, digests);
    return codes;
  }

  /**
   * Regenerates the ten recovery codes for a principal with a confirmed factor,
   * replacing the earlier set.
   *
   * Requires `proof` of the current factor (a TOTP code or an unused recovery
   * code): regenerating invalidates every code the user holds and hands the new
   * ones to the caller, so without proof it would let anyone able to name the
   * principal mint codes that complete its sign-in. The first set is minted by
   * {@linkcode confirmEnrolment}, not here.
   *
   * Each code is 10 random bytes encoded as 16 base32 characters (80 bits),
   * stored as a SHA-256 digest; the plaintext is returned this once.
   *
   * @param principalId - The principal to regenerate codes for
   * @param proof - A code from the current factor or an unused recovery code
   * @returns The new codes, or why the regeneration was refused
   */
  async generateRecoveryCodes(
    principalId: string,
    proof?: string,
  ): Promise<RecoveryCodesResult> {
    const enrolment = await this.#store.getEnrolment(principalId);
    if (enrolment === null || !enrolment.confirmed) {
      return { status: 'not-enrolled' };
    }
    if (proof === undefined) {
      return { status: 'proof-required' };
    }
    const proven = await this.#verifyProof(principalId, proof);
    if (proven !== 'ok') {
      return { status: proven };
    }
    return { status: 'ok', recoveryCodes: await this.#mintRecoveryCodes(principalId) };
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
    if (!(await this.#reserve(principalId))) {
      return 'locked';
    }
    if (typeof code !== 'string') {
      return 'invalid';
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
   * Disables TOTP for a principal, deleting the enrolment, recovery codes, and
   * attempt counts.
   *
   * A confirmed factor needs `proof` of itself (a TOTP code or an unused
   * recovery code): disabling it and then enrolling a new authenticator would
   * otherwise be a takeover by anyone able to name the principal. An
   * unconfirmed enrolment is removed without proof, since it was never a
   * factor. An administrator reset that cannot obtain proof calls the store's
   * `deleteEnrolment` directly, behind its own authorization.
   *
   * @param principalId - The principal to disable TOTP for
   * @param proof - A code from the current factor or an unused recovery code
   * @returns `'ok'`, or why the call was refused
   */
  async disable(principalId: string, proof?: string): Promise<DisableResult> {
    const enrolment = await this.#store.getEnrolment(principalId);
    if (enrolment === null) {
      return 'not-enrolled';
    }
    if (enrolment.confirmed) {
      if (proof === undefined) {
        return 'proof-required';
      }
      const proven = await this.#verifyProof(principalId, proof);
      if (proven !== 'ok') {
        return proven;
      }
    }
    await this.#store.deleteEnrolment(principalId);
    return 'ok';
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
