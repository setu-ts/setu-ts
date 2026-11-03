/**
 * The ONE tenant check — run by the tenant middleware for every resolved id
 * and by `IMultiTenancyService.lookupTenant`, so a queue handler validating a
 * payload's tenant gets the answer the HTTP path would give. Internal: not
 * exported from `src/index.ts`.
 *
 * It also owns the ONE definition of a well-formed registry answer
 * ({@linkcode snapshotAnswer}), shared with the caching registry so the cache
 * can never store an answer the check would refuse.
 *
 * @module
 */
import type { ILogger, ITenant, ITenantRegistry, Option, SerializedError } from '@setu-ts/common';
import { describeError, maskUrlUserinfo, none, serializeError, some } from '@setu-ts/common';
import { TenantRegistryUnavailableError } from '../errors.ts';

/**
 * The longest tenant id (UTF-16 code units) ever handed to a registry. A
 * longer id is a miss without a lookup, so a header-sized string never reaches
 * a database query or a cache key — no resolver bounds the id itself.
 */
export const MAX_TENANT_ID_LENGTH = 256;

/** The `warn` emitted once per transition from healthy to failing. */
export const REGISTRY_FAULT_LOG =
  'Tenant registry lookup failed; requests naming a tenant answer 503';

/** The `info` emitted on the first success after a failure. */
export const REGISTRY_RECOVERED_LOG = 'Tenant registry lookups recovered';

/** What replaces the requested id wherever it appears in a logged registry error. */
export const MASKED_TENANT_ID = '<tenant-id>';

/**
 * A plain object — prototype `Object.prototype` or `null` — the only shape
 * `metadata` may take. Arrays, `Map`s and class instances are dropped rather
 * than spread into an object that loses their contents.
 */
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Builds the frozen tenant every request receives from a tenant-shaped value:
 * `id`, plus `name` when it is a string and `metadata` when it is a plain
 * object (itself a frozen shallow copy). Every member is read EXACTLY ONCE,
 * so a getter cannot pass validation with one value and serve another; any
 * other key on the value is dropped. Objects nested deeper inside `metadata`
 * are not copied — they stay the application's.
 *
 * @param value - The candidate tenant
 * @returns The frozen tenant, or `undefined` when `id` is not a non-empty string
 */
function snapshotTenant(value: unknown): ITenant | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { id, name, metadata } = value as { id?: unknown; name?: unknown; metadata?: unknown };
  if (typeof id !== 'string' || id === '') return undefined;
  return Object.freeze({
    id,
    ...(typeof name === 'string' && { name }),
    ...(isPlainObject(metadata) && { metadata: Object.freeze({ ...metadata }) }),
  });
}

/**
 * Returns a frozen copy of a tenant — the static registry's storage form.
 *
 * @param tenant - The tenant to copy (its `id` already validated)
 * @returns A frozen copy no handler can mutate at the top level
 * @throws {TypeError} When `tenant.id` is not a non-empty string
 */
export function freezeTenant(tenant: ITenant): ITenant {
  const frozen = snapshotTenant(tenant);
  if (frozen === undefined) {
    throw new TypeError('A tenant needs a non-empty string id.');
  }
  return frozen;
}

/**
 * Validates and snapshots a registry answer — the single definition of
 * well-formed, used by the check and by the cache. Every member of the answer
 * and of its tenant is read once; a throwing accessor reads as malformed.
 *
 * @param answer - Whatever a registry's `lookup` resolved to
 * @returns `none()`, `some(frozenTenant)`, or `undefined` when malformed
 */
export function snapshotAnswer(answer: unknown): Option<ITenant> | undefined {
  try {
    if (typeof answer !== 'object' || answer === null) return undefined;
    const { present, value } = answer as { present?: unknown; value?: unknown };
    if (present === false) return none();
    if (present !== true) return undefined;
    const tenant = snapshotTenant(value);
    return tenant === undefined ? undefined : some(tenant);
  } catch {
    return undefined;
  }
}

/**
 * Characters that make a match part of a longer word rather than a standalone
 * quote. ASCII only: next to a non-ASCII letter the id is still masked, which
 * errs towards masking more.
 */
const WORD_CHARACTER = '[A-Za-z0-9_-]';

/** Escapes a string for literal use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes the requested id from a logged description. A registry or driver
 * error may quote the bound value verbatim (`invalid input syntax for type
 * uuid: "…"`), so both the raw id and the id as `describeError` renders it —
 * control characters collapsed to spaces — are replaced.
 *
 * The replacement is ONE pass over the text, so an inserted marker is never
 * searched again, and it masks a form only where it stands alone — not
 * touching a letter, digit, `_` or `-` on either side — so a short id such as
 * `e` cannot shred the rest of the message. A quote the registry altered
 * (lower-cased, escaped, truncated) is not recognized.
 *
 * @param text - The description of the registry's error
 * @param id - The requested id
 * @returns The description with every standalone occurrence of the id masked
 */
export function maskTenantId(text: string, id: string): string {
  const rendered = describeError(new Error(id))
    .replace(/^Error: /, '')
    .trim();
  const forms = [...new Set([id, rendered])]
    .filter((form) => form !== '')
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (forms.length === 0) return text;
  const pattern = new RegExp(
    `(?<!${WORD_CHARACTER})(?:${forms.join('|')})(?!${WORD_CHARACTER})`,
    'g',
  );
  return text.replace(pattern, MASKED_TENANT_ID);
}

/**
 * The answers the plugin's own cache served without asking the registry
 * behind it. Module-private: only {@linkcode markServedFromCache} adds to it
 * and only {@linkcode TenantCheck} reads it, so no registry object — the
 * application's included — is ever probed for a member, and a lookup in it
 * cannot throw. A `WeakSet`, so it holds nothing alive.
 */
const servedFromCache = new WeakSet<object>();

/**
 * Records that `answer` came from the plugin's cache, not from a registry.
 * Called by `CachingTenantRegistry` on each hit it serves; not exported from
 * `src/index.ts`.
 *
 * @param answer - The cache hit about to be returned
 * @returns The same answer
 */
export function markServedFromCache<T extends object>(answer: T): T {
  servedFromCache.add(answer);
  return answer;
}

/**
 * Owns the whole admit/refuse decision for a tenant id, and the fault-state
 * logging. The registry is late-bound for the factory arm.
 */
export class TenantCheck {
  #registry: ITenantRegistry | undefined;
  readonly #configured: boolean;
  readonly #logger: ILogger | undefined;
  #failing = false;

  /**
   * @param options.configured - Whether a `tenants` registry is configured at
   * all; `false` means every id is admitted (the behaviour without `tenants`)
   * @param options.registry - The registry, when known at `register()`
   * @param options.logger - Receives the fault/recovery transitions
   */
  constructor(options: { configured: boolean; registry?: ITenantRegistry; logger?: ILogger }) {
    this.#configured = options.configured;
    this.#registry = options.registry;
    this.#logger = options.logger;
  }

  /** Binds a factory-built registry, from the plugin's `onInit`. */
  bind(registry: ITenantRegistry): void {
    this.#registry = registry;
  }

  /**
   * Checks a tenant id.
   *
   * @param id - The requested id (untrusted)
   * @returns `some(tenant)` — a fresh frozen snapshot holding only `id`,
   * `name` and `metadata` — to admit, `none()` to refuse
   * @throws {TenantRegistryUnavailableError} When the registry is not bound,
   * throws, or answers malformed
   */
  async check(id: string): Promise<Option<ITenant>> {
    if (!this.#configured) return some(Object.freeze({ id }));
    if (id.length > MAX_TENANT_ID_LENGTH) return none();
    const registry = this.#registry;
    if (registry === undefined) {
      throw this.#fault(
        new TenantRegistryUnavailableError(
          'MultiTenancyPlugin: the tenants factory is resolved in onInit; a lookup before onInit has no registry',
        ),
        id,
      );
    }
    let answer: unknown;
    try {
      answer = await registry.lookup(id);
    } catch (cause) {
      throw this.#fault(
        new TenantRegistryUnavailableError('The tenant registry lookup threw', { cause }),
        id,
      );
    }
    const snapshot = snapshotAnswer(answer);
    if (snapshot === undefined) {
      throw this.#fault(
        new TenantRegistryUnavailableError(
          'The tenant registry returned a malformed answer (expected none() or some({ id }))',
          { cause: answer },
        ),
        id,
      );
    }
    // A cache hit says nothing about the registry behind it: only a real
    // answer ends a fault state, so a client alternating a cached tenant with
    // uncached ids cannot make the fault and recovery lines flap.
    if (
      this.#failing &&
      !(typeof answer === 'object' && answer !== null && servedFromCache.has(answer))
    ) {
      this.#failing = false;
      this.#logger?.info(REGISTRY_RECOVERED_LOG);
    }
    return snapshot;
  }

  /** Logs the healthy→failing transition once, then returns the error to throw. */
  #fault(error: TenantRegistryUnavailableError, id: string): TenantRegistryUnavailableError {
    if (!this.#failing) {
      this.#failing = true;
      this.#logger?.warn(REGISTRY_FAULT_LOG, { error: describeRegistryFault(error, id) });
    }
    return error;
  }
}

/** Longest rendered name or classifier value, in code points, marker included. */
const MAX_FAULT_PART_LENGTH = 256;

/** Longest rendered fault line, in code points, marker included. */
const MAX_FAULT_LINE_LENGTH = 2048;

/** Appended to a part or line cut at its bound; counted within the bound. */
const TRUNCATION_MARKER = '… [truncated]';

/**
 * Collapses control and format characters and whitespace runs, then bounds the
 * length: the result is at most `max` code points, the marker included.
 */
function cleanFaultPart(value: string, max: number): string {
  const collapsed = value.replace(/[\p{C}\s]+/gu, ' ').trim();
  const points = [...collapsed];
  if (points.length <= max) return collapsed;
  return `${points.slice(0, max - TRUNCATION_MARKER.length).join('')}${TRUNCATION_MARKER}`;
}

/**
 * Renders one registry-supplied value (an error name or a classifier) for the
 * line. URL userinfo is masked first: masking the id first would let a client
 * whose id matches a URL's scheme (`redis`, `/`) break the URL apart so its
 * credentials are no longer recognized. Then the id is masked, on text not yet
 * collapsed or cut by this function, then the value is cleaned and bounded.
 * A classifier arrives already cut at 512 code points by `serializeError`, so
 * an id straddling that cut is only partly present and not recognized.
 */
function renderFaultValue(value: string, id: string): string {
  return cleanFaultPart(maskTenantId(maskUrlUserinfo(value), id), MAX_FAULT_PART_LENGTH);
}

/** Renders one serialized error without its message: `Name (code=…, …)`. */
function describeWithoutMessage(error: SerializedError, id: string): string {
  const name = renderFaultValue(error.name, id) || 'Error';
  const classifiers = Object.entries(error.classifiers ?? {}).map(
    ([key, value]) => `${key}=${renderFaultValue(String(value), id)}`,
  );
  const members =
    error.errors !== undefined && error.errors.length > 0
      ? ` [${error.errors.map((member) => describeWithoutMessage(member, id)).join('; ')}]`
      : '';
  return `${name}${classifiers.length > 0 ? ` (${classifiers.join(', ')})` : ''}${members}`;
}

/**
 * Renders a registry fault for the warn log WITHOUT any registry-supplied
 * message text (M127 security audit F-1). A registry's or driver's message may
 * quote the requested id in any encoding — verbatim, JSON-escaped,
 * case-folded, truncated — so no mask over the message can be complete. The
 * line therefore carries only:
 *
 * - the plugin's own `TenantRegistryUnavailableError` message, a fixed
 *   sentence that never contains the id;
 * - for each error in the cause chain, its `name` and the driver classifiers
 *   `serializeError` allowlists (`code`, `errno`, `syscall`, `severity`,
 *   `constraint`, `codeName`, `statusCode`) — e.g.
 *   `Error (code=ECONNREFUSED, errno=-111, syscall=connect)`.
 *
 * A malformed registry answer, carried as the `cause`, therefore contributes
 * only its type name, never its contents. Each name and classifier value has
 * URL userinfo masked first (as `describeError` does), then is passed through
 * {@linkcode maskTenantId} before this plugin collapses or cuts it; a
 * classifier arrives already masked and cut at 512 code points by
 * `serializeError` (see `renderFaultValue`). That mask only recognizes a
 * standalone, unaltered copy of the id. A custom registry
 * that writes the id into an error's `name` or `code` in an altered form
 * (case-folded, encoded, cut mid-word) puts it in the line; registries should
 * keep the id out of names and codes.
 *
 * @param error - The fault the check is about to throw
 * @param id - The requested id
 * @returns One line of at most 2048 code points, with no registry message text
 */
export function describeRegistryFault(error: TenantRegistryUnavailableError, id: string): string {
  const own = serializeError(error);
  const parts = [`${own.name}: ${own.message}`];
  for (let cause = own.cause; cause !== undefined; cause = cause.cause) {
    parts.push(describeWithoutMessage(cause, id));
  }
  return cleanFaultPart(parts.join(' <- '), MAX_FAULT_LINE_LENGTH);
}
