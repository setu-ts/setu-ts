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
 * Single-process memory default for {@linkcode ISamlRequestStore}.
 *
 * Suitable for tests and one-replica deployments only: a second replica holds
 * its own map, so a login started on one and answered on the other is
 * refused. Expired entries are swept on every write, so the maps stay bounded
 * by the number of logins and assertions inside their lifetimes.
 *
 * @since 0.8.0
 */
export class MemorySamlRequestStore implements ISamlRequestStore {
  readonly #requests = new Map<string, SamlPendingRequest>();
  readonly #assertions = new Map<string, number>();

  /** Records a pending request, sweeping expired entries first. */
  saveRequest(request: SamlPendingRequest, now: number): Promise<void> {
    this.#sweep(now);
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
    this.#sweep(now);
    const held = this.#assertions.get(assertionId);
    if (held !== undefined && held > now) {
      return Promise.resolve(false);
    }
    this.#assertions.set(assertionId, retainUntil);
    return Promise.resolve(true);
  }

  /** Drops requests and assertion claims that expired at or before `now`. */
  #sweep(now: number): void {
    for (const [id, entry] of this.#requests) {
      if (entry.expiresAt <= now) {
        this.#requests.delete(id);
      }
    }
    for (const [id, until] of this.#assertions) {
      if (until <= now) {
        this.#assertions.delete(id);
      }
    }
  }
}
