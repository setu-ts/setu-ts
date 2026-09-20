/**
 * Bounds: rate buckets, concurrency lanes, header-byte budget, and response
 * size ceiling.
 *
 * The adversarial property this module delivers: a flood of malformed,
 * wrong-session, or wrong-MAC requests can never consume the paired
 * client's request budget or all processing slots. Raw-validation refusals
 * draw from a dedicated anonymous bucket (5 requests/second, burst 10) that
 * never debits any session budget; after `subtle.verify` succeeds, ONLY the
 * paired session's own bucket (20 requests/second, burst 40) applies. The
 * anonymous and authentication lanes together can hold at most seven of the
 * eight connector-handler slots, so one slot always remains reachable for a
 * successfully authenticated request.
 *
 * All timing comes from the injected monotonic `hrtime` clock.
 *
 * @module
 */

/**
 * The clock limits run on: the runtime's monotonic `hrtime()`.
 *
 * @internal
 */
export interface LimitsClock {
  /** Returns monotonic milliseconds. */
  hrtime(): number;
}

/**
 * The fixed limit values. Constants, not options: this transport has one
 * reviewed configuration, not a tuning surface.
 *
 * @internal
 */
export const CONNECTOR_LIMITS = {
  /** Anonymous refusal-bucket refill rate, refusals per second. */
  anonymousRatePerSecond: 5,
  /** Anonymous refusal-burst capacity. */
  anonymousBurst: 10,
  /** Per-session bucket refill rate, requests per second. */
  sessionRatePerSecond: 20,
  /** Per-session bucket burst capacity, requests. */
  sessionBurst: 40,
  /** Maximum simultaneous connector handlers. */
  maxHandlerConcurrency: 8,
  /** Maximum simultaneous handlers in the anonymous + authentication lanes. */
  preAuthConcurrency: 7,
  /** Maximum simultaneous handlers inside the authentication (verify) lane. */
  verifyingConcurrency: 4,
  /** Maximum total parsed header bytes (names, values) per request. */
  maxHeaderBytes: 8 * 1024,
  /** Maximum signed response body bytes. */
  maxResponseBytes: 256 * 1024,
  /** Maximum events per read. */
  maxEventLimit: 128,
} as const;

/**
 * A monotonic token bucket: refill continuously at `ratePerSecond`, capped
 * at `burst`, debit one token per admitted event.
 *
 * @internal
 */
class TokenBucket {
  readonly #burst: number;
  readonly #ratePerSecond: number;
  #tokens: number;
  #lastHr: number;

  constructor(burst: number, ratePerSecond: number, startHr: number) {
    this.#burst = burst;
    this.#ratePerSecond = ratePerSecond;
    this.#tokens = burst;
    this.#lastHr = startHr;
  }

  /**
   * Attempts to take one token at `nowHr`.
   *
   * @param nowHr - Monotonic milliseconds
   * @returns `true` when a token was available and taken
   */
  tryTake(nowHr: number): boolean {
    const elapsedMs = Math.max(0, nowHr - this.#lastHr);
    this.#lastHr = nowHr;
    this.#tokens = Math.min(
      this.#burst,
      this.#tokens + (elapsedMs / 1000) * this.#ratePerSecond,
    );
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * The concurrency/rate admission state for one connector instance.
 *
 * Concurrency: `#total` caps every in-flight handler at 8. Requests whose
 * session ID does NOT match the paired session (every unpaired client) are
 * held to the anonymous/authentication lanes, capped together at 7 — so an
 * unpaired flood can never hold all eight slots, and the eighth always
 * remains reachable for the paired client, whose ID matches at admission
 * time. A wrong-MAC flood carrying the (secret) paired ID is additionally
 * bounded by the verify lane's own cap of 4.
 *
 * Rate: the anonymous bucket debits ONLY when a raw-validation refusal is
 * answered; the per-session bucket debits ONLY after verification
 * succeeded.
 *
 * @internal
 */
export class ConnectorLimits {
  readonly #clock: LimitsClock;
  readonly #anonymous: TokenBucket;
  readonly #sessionBuckets = new Map<string, TokenBucket>();
  #total = 0;
  #unpaired = 0;
  #verifying = 0;

  constructor(clock: LimitsClock) {
    this.#clock = clock;
    this.#anonymous = new TokenBucket(
      CONNECTOR_LIMITS.anonymousBurst,
      CONNECTOR_LIMITS.anonymousRatePerSecond,
      clock.hrtime(),
    );
  }

  /**
   * Admits one handler. `paired` is the cheap admission-time comparison of
   * the request's session-ID header against the paired session's ID — the
   * one decision that separates the paired client (admitted against the
   * total cap only) from every unpaired client (admitted against the
   * 7-slot lanes). No rate bucket is touched here; rate applies where it
   * belongs (refusals via {@linkcode admitRawRefusal}, authenticated work
   * via {@linkcode promote}).
   *
   * @param paired - Whether the request carried the paired session ID
   * @returns `true` when the request may proceed
   */
  beginHandler(paired: boolean): boolean {
    if (this.#total >= CONNECTOR_LIMITS.maxHandlerConcurrency) {
      return false;
    }
    if (!paired && this.#unpaired >= CONNECTOR_LIMITS.preAuthConcurrency) {
      return false;
    }
    this.#total += 1;
    if (!paired) {
      this.#unpaired += 1;
    }
    return true;
  }

  /**
   * PAYS for one raw-validation refusal from the anonymous refusal budget.
   * Called only when a structural check FAILED, to decide whether the
   * refusal is answered with its own error or with `rate-limited`; it never
   * debits any session budget.
   *
   * @returns `true` when the refusal budget allowed the specific error
   */
  admitRawRefusal(): boolean {
    return this.#anonymous.tryTake(this.#clock.hrtime());
  }

  /**
   * Moves the request into the authentication (verify) lane.
   *
   * @returns `true` when the verify lane had capacity
   */
  beginVerify(): boolean {
    if (this.#verifying >= CONNECTOR_LIMITS.verifyingConcurrency) {
      return false;
    }
    this.#verifying += 1;
    return true;
  }

  /**
   * Promotes a verified request out of the anonymous/authentication lanes
   * into the authenticated phase and debits the session's rate bucket —
   * the first and only touch of the session budget, strictly after
   * `subtle.verify` succeeded.
   *
   * @param sessionId - The paired session's ID (its bucket key)
   * @returns `true` when the session budget allowed the request
   */
  promote(sessionId: string): boolean {
    let bucket = this.#sessionBuckets.get(sessionId);
    if (bucket === undefined) {
      bucket = new TokenBucket(
        CONNECTOR_LIMITS.sessionBurst,
        CONNECTOR_LIMITS.sessionRatePerSecond,
        this.#clock.hrtime(),
      );
      this.#sessionBuckets.set(sessionId, bucket);
    }
    if (!bucket.tryTake(this.#clock.hrtime())) {
      return false;
    }
    // The verify-lane slot is consumed; the total slot is kept.
    this.#verifying -= 1;
    return true;
  }

  /**
   * Releases one in-flight handler slot. `paired` must be the same value
   * the handler was admitted with — it decides whether an unpaired-lane
   * slot is also released.
   *
   * @param paired - Whether the handler was admitted as the paired client
   */
  release(paired: boolean): void {
    if (this.#total <= 0 || (!paired && this.#unpaired <= 0)) {
      throw new Error('Connector limits: released a slot that was not held.');
    }
    this.#total -= 1;
    if (!paired) {
      this.#unpaired -= 1;
    }
  }

  /**
   * Releases the verify-lane slot for a handler whose verification FAILED
   * (a promoted handler's verify slot was consumed by {@linkcode promote}).
   */
  endVerify(): void {
    if (this.#verifying <= 0) {
      throw new Error('Connector limits: released a verify slot that was not held.');
    }
    this.#verifying -= 1;
  }

  /**
   * Computes the UTF-8 byte total of every header name and value and
   * checks it against the fixed 8 KiB budget. This is an application-level
   * bound applied after HTTP parsing; native parser limits remain the
   * runtime's responsibility.
   *
   * @param headers - The mapped request headers
   * @returns `true` when the headers fit the budget
   */
  headersWithinBudget(headers: Headers): boolean {
    let total = 0;
    headers.forEach((value, name) => {
      total += ENCODER.encode(name).length + ENCODER.encode(value).length;
    });
    return total <= CONNECTOR_LIMITS.maxHeaderBytes;
  }
}

const ENCODER = new TextEncoder();
