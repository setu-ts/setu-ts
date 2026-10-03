/**
 * The SAML pending-request and assertion-replay store port, and its memory
 * default (M100f plan §3.4–§3.5).
 *
 * The IdP returns by a cross-site `POST`, which the default `SameSite=Lax`
 * session cookie does not accompany, so the request the ACS checks a response
 * against cannot live in the session. It lives here instead, and this same
 * store is handed to node-saml as its `cacheProvider`, so the request id the
 * library validates and the entry the plugin consumes are one record.
 *
 * Every implementation MUST make {@linkcode ISamlRequestStore.consumeRequest}
 * and {@linkcode ISamlRequestStore.claimAssertionId} atomic: two concurrent
 * posts of one response must see exactly one winner, or a captured response
 * signs in twice.
 *
 * @module
 */

/**
 * A pending SP-initiated login, recorded when the login route issues an
 * AuthnRequest.
 *
 * @since 0.8.0
 */
export interface SamlPendingRequest {
  /** The AuthnRequest `ID`; the response's `InResponseTo` must name it. */
  readonly requestId: string;
  /** The provider the login was started against. */
  readonly provider: string;
  /** The validated same-origin path to send the browser to afterwards. */
  readonly returnTo: string;
  /**
   * The random value held in the browser-binding cookie. The ACS refuses a
   * response whose browser does not present it.
   */
  readonly binding: string;
  /** The AuthnRequest `IssueInstant`, as the library recorded it. */
  readonly issuedAt: string;
  /** When the entry stops being honoured, from `runtime.now()`, in ms. */
  readonly expiresAt: number;
}

/**
 * Store port for pending SAML requests and consumed assertion ids.
 *
 * All methods are async so a shared backend (Redis, a database) can implement
 * the interface; an application running several replicas MUST supply one,
 * because a login started on one replica is answered on whichever receives
 * the IdP's `POST`.
 *
 * @since 0.8.0
 */
export interface ISamlRequestStore {
  /** Records a pending request; `now` lets an implementation sweep expired entries. */
  saveRequest(request: SamlPendingRequest, now: number): Promise<void>;
  /**
   * Reads a pending request WITHOUT consuming it, or `null` when absent or
   * expired at `now`.
   */
  peekRequest(requestId: string, now: number): Promise<SamlPendingRequest | null>;
  /**
   * Atomically removes a pending request and returns it, or `null` when it
   * was already consumed, never existed, or has expired at `now`. Of two
   * concurrent calls for one id, exactly one receives the record.
   */
  consumeRequest(requestId: string, now: number): Promise<SamlPendingRequest | null>;
  /**
   * Atomically records an assertion id as used until `retainUntil` (ms).
   * Returns `true` on the first claim and `false` when the id was already
   * claimed and has not yet aged out.
   */
  claimAssertionId(assertionId: string, retainUntil: number, now: number): Promise<boolean>;
}

/**
 * Default cap on pending requests held by {@linkcode MemorySamlRequestStore}.
 *
 * @since 0.8.0
 */
export const DEFAULT_MAX_PENDING_SAML_REQUESTS = 10_000;

/**
 * Options for {@linkcode MemorySamlRequestStore}.
 *
 * @since 0.8.0
 */
export interface MemorySamlRequestStoreOptions {
  /**
   * Most pending requests held at once. The login route is unauthenticated, so
   * without a cap a flood of `GET …/login` grows the map for the whole pending
   * lifetime. Past the cap the OLDEST pending request is evicted — its login
   * fails closed and is retried — so memory stays bounded and new logins keep
   * working. Defaults to {@linkcode DEFAULT_MAX_PENDING_SAML_REQUESTS}; must be
   * a positive integer. Rate-limit the login route as well.
   */
  readonly maxPendingRequests?: number;
}

/**
 * Single-process memory default for {@linkcode ISamlRequestStore}.
 *
 * Suitable for tests and one-replica deployments only: a second replica holds
 * its own map, so a login started on one and answered on the other is
 * refused. Pending requests are capped (oldest evicted first) and expire after
 * a fixed lifetime, so they are kept in expiry order and swept from the front
 * — a write costs O(expired), never a walk of the whole map. Assertion claims
 * need a validly signed assertion each, and are swept when their map has
 * doubled since the last sweep.
 *
 * @since 0.8.0
 */
export class MemorySamlRequestStore implements ISamlRequestStore {
  readonly #requests = new Map<string, SamlPendingRequest>();
  readonly #assertions = new Map<string, number>();
  readonly #maxPending: number;
  #assertionSweepAt = 64;

  /**
   * Creates a memory store.
   *
   * @param options - Bounds; see {@linkcode MemorySamlRequestStoreOptions}
   * @throws {RangeError} When `maxPendingRequests` is not a positive integer
   */
  constructor(options: MemorySamlRequestStoreOptions = {}) {
    const max = options.maxPendingRequests ?? DEFAULT_MAX_PENDING_SAML_REQUESTS;
    if (!Number.isSafeInteger(max) || max <= 0) {
      throw new RangeError('MemorySamlRequestStore: maxPendingRequests must be a positive integer');
    }
    this.#maxPending = max;
  }

  /** Records a pending request, dropping expired ones and evicting the oldest past the cap. */
  saveRequest(request: SamlPendingRequest, now: number): Promise<void> {
    // Insertion order is expiry order (every request gets the same lifetime),
    // so expired entries are a prefix of the map.
    for (const [id, entry] of this.#requests) {
      if (entry.expiresAt > now) {
        break;
      }
      this.#requests.delete(id);
    }
    this.#requests.delete(request.requestId);
    while (this.#requests.size >= this.#maxPending) {
      const oldest = this.#requests.keys().next().value as string;
      this.#requests.delete(oldest);
    }
    this.#requests.set(request.requestId, request);
    return Promise.resolve();
  }

  /** Reads a pending request without consuming it; `null` when absent or expired. */
  peekRequest(requestId: string, now: number): Promise<SamlPendingRequest | null> {
    const entry = this.#requests.get(requestId);
    return Promise.resolve(entry === undefined || entry.expiresAt <= now ? null : entry);
  }

  /** Removes and returns a pending request in one synchronous step; `null` when absent or expired. */
  consumeRequest(requestId: string, now: number): Promise<SamlPendingRequest | null> {
    // Read and delete in one synchronous step: no await separates them, so two
    // concurrent callers cannot both observe the entry.
    const entry = this.#requests.get(requestId);
    this.#requests.delete(requestId);
    return Promise.resolve(entry === undefined || entry.expiresAt <= now ? null : entry);
  }

  /** Claims an assertion id until `retainUntil`; `false` while an earlier claim is held. */
  claimAssertionId(assertionId: string, retainUntil: number, now: number): Promise<boolean> {
    const held = this.#assertions.get(assertionId);
    if (held !== undefined && held > now) {
      return Promise.resolve(false);
    }
    this.#assertions.set(assertionId, retainUntil);
    if (this.#assertions.size >= this.#assertionSweepAt) {
      // Amortized: a full sweep only when the map has doubled since the last.
      for (const [id, until] of this.#assertions) {
        if (until <= now) {
          this.#assertions.delete(id);
        }
      }
      this.#assertionSweepAt = Math.max(64, this.#assertions.size * 2);
    }
    return Promise.resolve(true);
  }
}
