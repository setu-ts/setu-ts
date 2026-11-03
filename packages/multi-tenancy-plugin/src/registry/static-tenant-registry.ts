/**
 * The static tenant registry — what a `tenants` ARRAY becomes. Internal: not
 * exported from `src/index.ts`.
 *
 * @module
 */
import type { ITenant, ITenantRegistry, Option } from '@setu-ts/common';
import { none, some } from '@setu-ts/common';
import { freezeTenant, MAX_TENANT_ID_LENGTH } from './tenant-check.ts';

/** The option name every refusal starts with. */
const OPTION = 'MultiTenancyPlugin: the `tenants` option';

/**
 * Validates one list entry's id, throwing an `Error` naming the option.
 *
 * @param id - The candidate id
 * @param index - The entry's position, for the message
 */
function assertListedId(id: unknown, index: number): asserts id is string {
  if (typeof id !== 'string') {
    throw new Error(`${OPTION} entry ${index} has a non-string id.`);
  }
  if (id.length === 0) {
    throw new Error(`${OPTION} entry ${index} has an empty id.`);
  }
  if (id.trim() !== id) {
    throw new Error(
      `${OPTION} entry ${index} has leading or trailing whitespace; resolvers trim, so it could never match.`,
    );
  }
  if (id.length > MAX_TENANT_ID_LENGTH) {
    throw new Error(
      `${OPTION} entry ${index} is longer than ${MAX_TENANT_ID_LENGTH} characters; it could never match.`,
    );
  }
}

/**
 * An `ITenantRegistry` over a fixed list. Backed by a `Map`, so an id such as
 * `'__proto__'` or `'constructor'` is a miss unless it is listed. Each stored
 * tenant is a frozen copy (see `freezeTenant`), so a handler cannot mutate the
 * object other requests receive.
 */
export class StaticTenantRegistry implements ITenantRegistry {
  readonly #tenants: ReadonlyMap<string, ITenant>;

  /**
   * Parses and validates the list.
   *
   * @param entries - The `tenants` array: ids, or tenants
   * @throws {Error} Naming the option, for an empty list, a non-string, empty,
   * untrimmed or over-long id, or a duplicate id
   */
  constructor(entries: readonly (string | ITenant)[]) {
    if (entries.length === 0) {
      throw new Error(`${OPTION} is an empty list; no request could ever be admitted.`);
    }
    const tenants = new Map<string, ITenant>();
    entries.forEach((entry, index) => {
      const tenant: ITenant =
        typeof entry === 'string'
          ? { id: entry }
          : typeof entry === 'object' && entry !== null
            ? entry
            : ({ id: entry } as unknown as ITenant);
      assertListedId(tenant.id, index);
      if (tenants.has(tenant.id)) {
        throw new Error(`${OPTION} lists the id at entry ${index} more than once.`);
      }
      tenants.set(tenant.id, freezeTenant(tenant));
    });
    this.#tenants = tenants;
  }

  /** Answers the listed tenant, or `none()`. Never throws. */
  lookup(id: string): Promise<Option<ITenant>> {
    const tenant = this.#tenants.get(id);
    return Promise.resolve(tenant === undefined ? none() : some(tenant));
  }
}
