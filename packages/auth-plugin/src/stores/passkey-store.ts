/**
 * The passkey credential store port and its memory default (plan §3.7).
 *
 * The port is async so a remote backend (Redis, a database) can implement it
 * without a breaking change, following the refresh-token store precedent.
 * `MemoryPasskeyStore` is the default for tests and single-process
 * development; credentials are the application's data.
 *
 * Every implementation MUST honour {@linkcode IPasskeyStore.updateCounter} as
 * an atomic compare-and-advance: a read-then-write would let two concurrent
 * assertions both validate against the same stored counter and let the lower
 * one overwrite the higher — which is exactly how a cloned authenticator's
 * stale counter slips through.
 *
 * @module
 */

/** A stored passkey credential. */
export interface StoredPasskey {
  /** The credential id, base64url. */
  readonly id: string;
  /** The principal the credential belongs to. */
  readonly principalId: string;
  /** The opaque per-principal user handle, base64url (32 random bytes). */
  readonly userHandle: string;
  /** The credential's public key, in JWK form. */
  readonly publicKey: JsonWebKey;
  /** The COSE algorithm identifier the credential declared. */
  readonly algorithm: number;
  /**
   * The last accepted signature counter. Synced passkeys report `0` on every
   * use, so both-zero is the accepted steady state for them.
   */
  counter: number;
  /** Whether the authenticator reports the key as backed up. Display only. */
  readonly backedUp: boolean;
  /** The transports the client reported, or those configured at registration. */
  readonly transports: readonly string[];
  /** Attestation is never verified in this milestone (plan §3.2). */
  readonly attestation: 'unverified';
  /** When the credential was registered, from `runtime.now()`, in ms. */
  readonly createdAt: number;
}

/**
 * Store port for passkey credentials and single-use challenge claims.
 *
 * All methods are async so remote backends can implement the interface
 * without a breaking change.
 */
export interface IPasskeyStore {
  /** Lists every credential registered for a principal. */
  listByPrincipal(principalId: string): Promise<readonly StoredPasskey[]>;

  /** Reads one credential by id, or `null` when it is not stored. */
  findById(id: string): Promise<StoredPasskey | null>;

  /** Stores a newly registered credential. */
  save(credential: StoredPasskey): Promise<void>;

  /**
   * Atomically advances the stored counter to `observed`.
   *
   * Stores `observed` only when it is greater than the stored counter, or when
   * both are zero (a synced passkey's steady state), and reports whether it
   * did. A `false` answer means the assertion's counter did not advance past
   * the stored one — a replay, a regression, or a concurrent use — and the
   * verifier refuses it.
   *
   * @param id - The credential id
   * @param observed - The counter the assertion carried
   * @returns `true` when the stored counter now reflects `observed`
   */
  updateCounter(id: string, observed: number): Promise<boolean>;

  /** Deletes a credential. */
  delete(id: string): Promise<void>;

  /**
   * Atomically records a challenge as used until `expiresAt`.
   *
   * Answers `false` when the challenge was already claimed and its claim has
   * not expired. This is the server-side replay guard (plan §3.5): on the
   * default encrypted-cookie session strategy, removing the challenge from the
   * session only changes the cookie sent back, and an OLDER copy of the cookie
   * still carries it — so the session alone cannot stop a replayed assertion.
   *
   * @param challenge - The base64url challenge
   * @param now - The current wall-clock time in ms; the purge cutoff
   * @param expiresAt - The wall-clock time the claim lapses, in ms
   * @returns `true` when this call is the claim's first
   */
  claimChallenge(challenge: string, now: number, expiresAt: number): Promise<boolean>;
}

/** The memory store's challenge-claim row. */
interface ClaimRow {
  readonly expiresAt: number;
}

/**
 * The in-memory passkey store.
 *
 * Challenge claims are purged past their expiry on every claim, so the map
 * stays bounded (the `MemoryLock` lesson): a store that only grows would hand
 * a long-running process an unbounded map keyed by attacker-supplied
 * challenges.
 */
export class MemoryPasskeyStore implements IPasskeyStore {
  readonly #credentials = new Map<string, StoredPasskey>();
  readonly #claims = new Map<string, ClaimRow>();

  /**
   * Lists every credential registered for a principal.
   *
   * The methods are NOT `async` — they resolve synchronously, the same shape
   * the other memory stores ship — because an `async` method with no `await`
   * is a lint failure, and the port's async signature is what a remote
   * backend needs, not the memory one.
   */
  listByPrincipal(principalId: string): Promise<readonly StoredPasskey[]> {
    const found: StoredPasskey[] = [];
    for (const credential of this.#credentials.values()) {
      if (credential.principalId === principalId) {
        found.push(credential);
      }
    }
    return Promise.resolve(found);
  }

  /** Reads one credential by id, or `null` when it is not stored. */
  findById(id: string): Promise<StoredPasskey | null> {
    return Promise.resolve(this.#credentials.get(id) ?? null);
  }

  /** Stores a newly registered credential, copying it so a later mutation of the caller object cannot change what the store hands back. */
  save(credential: StoredPasskey): Promise<void> {
    // A copy, so a caller mutating its own object after `save` cannot change
    // what the store hands back.
    this.#credentials.set(credential.id, { ...credential });
    return Promise.resolve();
  }

  /** Atomically advances the stored counter to `observed`, reporting whether it did. */
  updateCounter(id: string, observed: number): Promise<boolean> {
    const credential = this.#credentials.get(id);
    if (credential === undefined) {
      return Promise.resolve(false);
    }
    const advances = observed > credential.counter;
    const bothZero = observed === 0 && credential.counter === 0;
    if (!advances && !bothZero) {
      return Promise.resolve(false);
    }
    if (advances) {
      credential.counter = observed;
    }
    return Promise.resolve(true);
  }

  /** Deletes a credential. */
  delete(id: string): Promise<void> {
    this.#credentials.delete(id);
    return Promise.resolve();
  }

  /** Atomically records a challenge as used until `expiresAt`, answering `false` on a second claim. */
  claimChallenge(challenge: string, now: number, expiresAt: number): Promise<boolean> {
    // Purge first, on the caller's clock: entries whose claim has lapsed can
    // never win a future comparison, so keeping them only grows the map.
    for (const [key, row] of this.#claims) {
      if (row.expiresAt <= now) {
        this.#claims.delete(key);
      }
    }
    if (this.#claims.has(challenge)) {
      return Promise.resolve(false);
    }
    this.#claims.set(challenge, { expiresAt });
    return Promise.resolve(true);
  }
}
