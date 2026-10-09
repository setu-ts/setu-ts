/**
 * The Durable Object side of the idempotency store (M109a §3.15).
 *
 * One object per store key; one storage entry. A Durable Object executes one
 * request at a time, so the read-compare-write in `#claim` is atomic with no
 * transaction — which is what makes this a genuine cross-replica store rather
 * than a best-effort one.
 *
 * The record lives in `state.storage`, never in a field: a Durable Object is
 * evicted after inactivity, and a record's TTL routinely outlives that.
 *
 * @module
 * @since 0.9.0
 */

/**
 * The storage surface {@linkcode IdempotencyObjectCore} needs.
 *
 * Written here rather than imported from the platform: `cloudflare:workers` is
 * unresolvable by Deno, and the published `IDurableObjectStorage` is
 * deliberately NOT widened — this facade adds `setAlarm`, which only the
 * idempotency object uses.
 *
 * @since 0.9.0
 */
export interface IIdempotencyObjectState {
  /** The object's transactional storage, plus the alarm it schedules. */
  readonly storage: {
    /** Reads a value. */
    get<T>(key: string): Promise<T | undefined>;
    /** Writes a value. */
    put<T>(key: string, value: T): Promise<void>;
    /** Deletes a value. */
    delete(key: string): Promise<boolean>;
    /** Arms the object's single alarm. */
    setAlarm(scheduledTimeMs: number): Promise<void>;
  };
}

/**
 * Options for {@linkcode IdempotencyObjectCore}.
 *
 * @since 0.9.0
 */
export interface IdempotencyObjectCoreOptions {
  /**
   * Wall-clock source, in epoch milliseconds. Defaults to `Date.now`.
   *
   * This is the documented §4.2 deviation the distributed lock object already
   * makes (`distributed-lock-object.ts:28-38`): a Durable Object is constructed
   * by the platform as `(state, env)` with no plugin context and therefore no
   * route to `IRuntimeServices`. This class IS the runtime boundary for the
   * object; injecting the seam keeps expiry testable without waiting.
   */
  readonly now?: () => number;
}

/** The one storage key. */
const RECORD_KEY = 'idempotency:record';

/** The persisted record shape. */
interface StoredRecord {
  /** `'p'` in progress, `'c'` complete. */
  readonly s: 'p' | 'c';
  /** The holder's token (absent once complete). */
  t?: string;
  /** The request fingerprint. */
  readonly f: string;
  /** Lease deadline, epoch ms. */
  readonly l: number;
  /** Expiry, epoch ms. */
  readonly e: number;
  /** The stored record (present once complete). */
  r?: string;
}

/** A validated claim body. */
interface ClaimBody {
  readonly token: string;
  readonly fingerprint: string;
  readonly leaseMs: number;
  readonly ttlMs: number;
}

/** The JSON answer a claim returns. */
interface ClaimAnswer {
  readonly outcome: 'claimed' | 'completed' | 'in-progress' | 'fingerprint-mismatch';
  readonly takeover?: boolean;
  readonly record?: string;
}

/** Parses a positive-integer field, or `undefined`. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * The idempotency Durable Object.
 *
 * @example
 * ```typescript
 * import { DurableObject } from 'cloudflare:workers';
 * import { IdempotencyObjectCore } from '@setu-ts/cloudflare-plugin';
 *
 * export class IdempotencyObject extends DurableObject {
 *   #core = new IdempotencyObjectCore(this.ctx);
 *   override fetch(request: Request): Promise<Response> {
 *     return this.#core.fetch(request);
 *   }
 *   override alarm(): Promise<void> {
 *     return this.#core.alarm();
 *   }
 * }
 * ```
 * @since 0.9.0
 */
export class IdempotencyObjectCore {
  readonly #state: IIdempotencyObjectState;
  readonly #now: () => number;

  /**
   * Creates the core over a Durable Object's state.
   *
   * @param state - The Durable Object's `ctx`
   * @param options - Optional seams; the defaults are the deployment path
   */
  constructor(state: IIdempotencyObjectState, options: IdempotencyObjectCoreOptions = {}) {
    this.#state = state;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Routes one idempotency operation.
   *
   * @param request - The request the store sent
   * @returns The operation's JSON result, or a 404 for an unknown path
   */
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/claim') {
      const body = await this.#readClaim(request);
      if (body === undefined) return new Response('Bad request', { status: 400 });
      return Response.json(await this.#claim(body));
    }
    if (pathname === '/complete') {
      const body = await this.#readSettle(request, true);
      if (body === undefined) return new Response('Bad request', { status: 400 });
      return Response.json({ result: await this.#complete(body.token, body.record, body.ttlMs) });
    }
    if (pathname === '/release') {
      const body = await this.#readSettle(request, false);
      if (body === undefined) return new Response('Bad request', { status: 400 });
      return Response.json({ result: await this.#release(body.token) });
    }
    return new Response('Not found', { status: 404 });
  }

  /**
   * The alarm handler: deletes an expired record, or re-arms an unexpired one.
   *
   * A `release` deletes the record and leaves any alarm armed; this finds no
   * record and returns (a no-op).
   *
   * @returns A promise resolved once the object's state is settled
   */
  async alarm(): Promise<void> {
    const record = await this.#readRaw();
    if (record === undefined) return;
    if (record.e <= this.#now()) {
      await this.#state.storage.delete(RECORD_KEY);
      return;
    }
    await this.#state.storage.setAlarm(record.e);
  }

  /** Parses and validates a `/claim` body FIRST (no storage access on failure). */
  async #readClaim(request: Request): Promise<ClaimBody | undefined> {
    const raw = await this.#json(request);
    if (raw === undefined) return undefined;
    const leaseMs = positiveInt(raw.leaseMs);
    const ttlMs = positiveInt(raw.ttlMs);
    if (
      typeof raw.token !== 'string' || typeof raw.fingerprint !== 'string' ||
      leaseMs === undefined || ttlMs === undefined
    ) {
      return undefined;
    }
    return { token: raw.token, fingerprint: raw.fingerprint, leaseMs, ttlMs };
  }

  /** Parses a `/complete` (`withRecord`) or `/release` body FIRST. */
  async #readSettle(
    request: Request,
    withRecord: boolean,
  ): Promise<{ token: string; record: string; ttlMs: number } | undefined> {
    const raw = await this.#json(request);
    if (raw === undefined) return undefined;
    if (typeof raw.token !== 'string') return undefined;
    if (!withRecord) return { token: raw.token, record: '', ttlMs: 0 };
    const ttlMs = positiveInt(raw.ttlMs);
    if (typeof raw.record !== 'string' || ttlMs === undefined) return undefined;
    return { token: raw.token, record: raw.record, ttlMs };
  }

  /** Reads a JSON body into a plain record, or `undefined` when unparseable. */
  async #json(request: Request): Promise<Record<string, unknown> | undefined> {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return undefined;
    }
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  }

  /** Reads the stored record exactly as persisted, expiry included. */
  async #readRaw(): Promise<StoredRecord | undefined> {
    return await this.#state.storage.get<StoredRecord>(RECORD_KEY);
  }

  /** Reads the stored record, treating an expired one as absent. */
  async #read(): Promise<StoredRecord | undefined> {
    const record = await this.#readRaw();
    if (record === undefined) return undefined;
    if (record.e <= this.#now()) return undefined;
    return record;
  }

  /**
   * Claims the key. NO non-storage await happens after validation until the
   * answer is built (the input gate).
   */
  async #claim(body: ClaimBody): Promise<ClaimAnswer> {
    const now = this.#now();
    const record = await this.#read();
    if (record === undefined) {
      const fresh: StoredRecord = {
        s: 'p',
        t: body.token,
        f: body.fingerprint,
        l: now + body.leaseMs,
        e: now + body.ttlMs,
      };
      await this.#state.storage.put(RECORD_KEY, fresh);
      await this.#state.storage.setAlarm(fresh.e);
      return { outcome: 'claimed', takeover: false };
    }
    if (record.f !== body.fingerprint) return { outcome: 'fingerprint-mismatch' };
    if (record.s === 'c') return { outcome: 'completed', record: record.r ?? '' };
    if (record.l > now) return { outcome: 'in-progress' };
    const taken: StoredRecord = {
      s: 'p',
      t: body.token,
      f: body.fingerprint,
      l: now + body.leaseMs,
      e: now + body.ttlMs,
    };
    await this.#state.storage.put(RECORD_KEY, taken);
    await this.#state.storage.setAlarm(taken.e);
    return { outcome: 'claimed', takeover: true };
  }

  /** Settles a held claim into a completed record. */
  async #complete(token: string, record: string, ttlMs: number): Promise<'settled' | 'lost'> {
    const current = await this.#read();
    if (current === undefined || current.s !== 'p' || current.t !== token) return 'lost';
    const now = this.#now();
    const completed: StoredRecord = {
      s: 'c',
      f: current.f,
      l: current.l,
      e: now + ttlMs,
      r: record,
    };
    await this.#state.storage.put(RECORD_KEY, completed);
    await this.#state.storage.setAlarm(completed.e);
    return 'settled';
  }

  /** Releases a held claim, deleting the record. */
  async #release(token: string): Promise<'settled' | 'lost'> {
    const current = await this.#read();
    if (current === undefined || current.s !== 'p' || current.t !== token) return 'lost';
    await this.#state.storage.delete(RECORD_KEY);
    return 'settled';
  }
}
