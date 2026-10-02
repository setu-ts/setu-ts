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

  /**
   * Atomically stores a NEWLY registered credential.
   *
   * This is a compare-and-set, not a blind write, and BOTH conditions are
   * checked in the same atomic step as the insert:
   *
   * - no credential with the same id is already present — two ceremonies
   *   registering one credential id concurrently (a synced or cloned
   *   authenticator shared across accounts) must not both succeed with the
   *   later record silently replacing the earlier one, `principalId` included;
   * - the principal holds fewer than `options.maxPerPrincipal` credentials — a
   *   count checked before a separate write lets a burst of concurrent
   *   registrations overshoot the cap.
   *
   * A duplicate id answers `'duplicate'` (checked first), a full principal
   * answers `'limit'`, and neither writes anything. The registration ceremony
   * maps them to `409 credential-duplicate` and `409 credential-limit`.
   *
   * @param credential - The credential to store
   * @param options - The per-principal credential cap to enforce
   * @returns `'saved'`, `'duplicate'` or `'limit'`
   */
  save(credential: StoredPasskey, options: PasskeySaveOptions): Promise<PasskeySaveResult>;

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

/** What {@linkcode IPasskeyStore.save} enforces atomically with the insert. */
export interface PasskeySaveOptions {
  /** The most credentials one principal may hold; the insert is refused at this count. */
  readonly maxPerPrincipal: number;
}

/** The outcome of {@linkcode IPasskeyStore.save}. */
export type PasskeySaveResult = 'saved' | 'duplicate' | 'limit';

/**
 * A detached copy of a stored credential — its JWK and transports included —
 * so neither a caller's later mutation of a saved record nor a mutation of a
 * record the store handed back can change what the store holds.
 */
function copyPasskey(credential: StoredPasskey): StoredPasskey {
  return {
    ...credential,
    publicKey: { ...credential.publicKey },
    transports: [...credential.transports],
  };
}

/**
 * The smallest claim-map size that triggers a sweep. Below it a full scan costs
 * nothing worth amortizing.
 */
const MIN_SWEEP_SIZE = 64;

/** The memory store's challenge-claim row. */
interface ClaimRow {
  readonly expiresAt: number;
}

/**
 * The in-memory passkey store.
 *
 * Challenge claims past their expiry are purged so the map stays bounded (the
 * `MemoryLock` lesson): a store that only grows would hand a long-running
 * process an unbounded map keyed by attacker-supplied challenges. The sweep is
 * AMORTIZED — it runs when the map has doubled since the previous one — because
 * a full scan on every claim is quadratic in the live claims, and claims are
 * reachable from unauthenticated requests. The map therefore holds at most
 * twice the claims that are live at the last sweep.
 */
export class MemoryPasskeyStore implements IPasskeyStore {
  readonly #credentials = new Map<string, StoredPasskey>();
  readonly #claims = new Map<string, ClaimRow>();
  /** The claim-map size at which the next sweep runs. */
  #sweepAt = MIN_SWEEP_SIZE;

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
        found.push(copyPasskey(credential));
      }
    }
    return Promise.resolve(found);
  }

  /** Reads one credential by id, or `null` when it is not stored. */
  findById(id: string): Promise<StoredPasskey | null> {
    const credential = this.#credentials.get(id);
    return Promise.resolve(credential === undefined ? null : copyPasskey(credential));
  }

  /**
   * Atomically stores a newly registered credential, refusing an id that is
   * already present or a principal already at `maxPerPrincipal`, and copying
   * the record (its array and JWK members
   * included) so a later mutation of the caller's object cannot change what
   * the store hands back.
   */
  save(credential: StoredPasskey, options: PasskeySaveOptions): Promise<PasskeySaveResult> {
    // Compare-and-set: an id that is already present is refused, never
    // overwritten, and a principal at the cap is refused — both checked in
    // the same synchronous step as the insert, so no concurrent ceremony can
    // interleave between the check and the write.
    if (this.#credentials.has(credential.id)) {
      return Promise.resolve('duplicate');
    }
    let held = 0;
    for (const stored of this.#credentials.values()) {
      if (stored.principalId === credential.principalId) {
        held++;
      }
    }
    if (held >= options.maxPerPrincipal) {
      return Promise.resolve('limit');
    }
    // A deep copy, so a caller mutating its own object after `save` cannot
    // change what the store hands back — the record's array and JWK members
    // are copied too, not shared by reference.
    this.#credentials.set(credential.id, copyPasskey(credential));
    return Promise.resolve('saved');
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
    // Purge on the caller's clock, amortized: entries whose claim has lapsed
    // can never win a future comparison, so keeping them only grows the map —
    // but scanning on every claim would cost O(live claims) per request.
    if (this.#claims.size >= this.#sweepAt) {
      for (const [key, row] of this.#claims) {
        if (row.expiresAt <= now) {
          this.#claims.delete(key);
        }
      }
      this.#sweepAt = Math.max(MIN_SWEEP_SIZE, this.#claims.size * 2);
    }
    // An unswept row that has lapsed is treated exactly as a purged one.
    const existing = this.#claims.get(challenge);
    if (existing !== undefined && existing.expiresAt > now) {
      return Promise.resolve(false);
    }
    this.#claims.set(challenge, { expiresAt });
    return Promise.resolve(true);
  }
}
