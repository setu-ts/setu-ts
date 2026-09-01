/**
 * Partition-key resolution for the Cosmos adapter.
 *
 * Cosmos addresses an item by the pair (partition key, `id`), and a point read
 * carrying the WRONG partition key answers **404** rather than an error
 * (measured). A mistyped path would therefore make every read of a healthy
 * container answer "not found" for the life of the process — the silent-failure
 * class M52c found on D1 and M52d on Durable Objects.
 *
 * So the partition key is DISCOVERED from the container definition rather than
 * configured, and a configuration that disagrees with the container is refused
 * by name at first use. The definition read is also what proves the container
 * exists, so discovery costs no round trip a correctness check would not have
 * cost anyway.
 *
 * @module
 */
import type { ICosmosDatabase } from './cosmos-client-types.ts';
import type { CosmosTarget } from './cosmos-mapping.ts';
import { parsePartitionKeyPath, renderPartitionKeyPath } from './cosmos-mapping.ts';

/**
 * The resolved partition key of one container: the document field paths that
 * compose it, in order.
 *
 * A single-element list is an ordinary partition key; more than one is a
 * hierarchical (`MultiHash`) key, whose point reads take an array of values in
 * the same order.
 *
 * @internal
 */
export interface ResolvedPartitionKey {
  /** The composing field paths, each a segment list, in definition order. */
  readonly paths: readonly (readonly string[])[];
}

/**
 * Resolves and caches the partition key of every container the adapter
 * touches.
 *
 * One instance is bound to one database handle and lives as long as the
 * connection: the partition key of a container cannot change, so the read is
 * performed once per container. A FAILED read is never cached — holding a
 * rejected promise would turn one transient outage into a permanently unusable
 * adapter, which is the defect `MongoAdapter.connect` was fixed for.
 *
 * @internal
 */
export class PartitionKeyResolver {
  readonly #database: ICosmosDatabase;
  readonly #cache = new Map<string, Promise<ResolvedPartitionKey>>();

  /**
   * Creates a resolver bound to one database handle.
   *
   * @param database - The database whose containers are resolved
   */
  constructor(database: ICosmosDatabase) {
    this.#database = database;
  }

  /**
   * Resolves the partition key for an entity's container.
   *
   * @param target - The resolved entity target
   * @returns The container's partition key
   * @throws {Error} When the container does not exist, when its definition
   *   carries no partition-key path, or when the mapping's configured path
   *   disagrees with the container's
   */
  resolve(target: CosmosTarget): Promise<ResolvedPartitionKey> {
    const cached = this.#cache.get(target.container);
    if (cached !== undefined) {
      // The cache is keyed by CONTAINER, but the mismatch refusal is a property
      // of the TARGET: two entities may map to one container, and validating
      // only inside the cached read would check the first mapping and silently
      // accept every later one — including a conflicting declaration, which is
      // exactly what the refusal exists to catch.
      return cached.then((resolved) => {
        this.#assertConfigured(target, resolved.paths);
        return resolved;
      });
    }
    const attempt = this.#read(target).catch((error: unknown) => {
      // Do not cache a failure: a missing container that is then created, or a
      // transient outage, must be re-readable.
      this.#cache.delete(target.container);
      throw error;
    });
    this.#cache.set(target.container, attempt);
    return attempt;
  }

  /**
   * Refuses a mapping whose declared partition key disagrees with the
   * container's own definition.
   *
   * @param target - The resolved entity target
   * @param actual - The paths the container declares
   * @throws {Error} When the two disagree
   */
  #assertConfigured(target: CosmosTarget, actual: readonly (readonly string[])[]): void {
    const configured = target.partitionKeyPaths;
    if (configured === null || samePaths(configured, actual)) return;
    throw new Error(
      `CosmosAdapter partition-key mismatch on container '${target.container}': the mapping ` +
        `declares ${renderPaths(configured)} but the container declares ${renderPaths(actual)}. ` +
        'A point read carrying the wrong partition key answers 404 rather than an error, so this ' +
        'is refused rather than served.',
    );
  }

  /**
   * Performs one container-definition read and validates the mapping against
   * it.
   *
   * @param target - The resolved entity target
   * @returns The container's partition key
   * @throws {Error} When the container is absent, carries no partition-key
   *   definition, or disagrees with the configured mapping
   */
  async #read(target: CosmosTarget): Promise<ResolvedPartitionKey> {
    const container = this.#database.container(target.container);
    let definition;
    try {
      definition = await container.read();
    } catch (error) {
      throw new Error(
        `CosmosAdapter could not read container '${target.container}': ${
          error instanceof Error ? error.message : String(error)
        }. Cosmos creates nothing implicitly — the container must exist before the application starts.`,
      );
    }
    const paths = definition.resource?.partitionKey?.paths ?? [];
    if (paths.length === 0) {
      throw new Error(
        `CosmosAdapter found no partition-key definition on container '${target.container}'`,
      );
    }
    const actual = paths.map(parsePartitionKeyPath);
    this.#assertConfigured(target, actual);
    return { paths: actual };
  }
}

/**
 * Compares two partition-key path lists for exact equality, including order —
 * a hierarchical key's order is part of its identity.
 *
 * @param left - The first path list
 * @param right - The second path list
 * @returns `true` when both name the same paths in the same order
 * @since 0.2.0
 */
export function samePaths(
  left: readonly (readonly string[])[],
  right: readonly (readonly string[])[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((path, index) => {
    const other = right[index] as readonly string[];
    return path.length === other.length && path.every((segment, i) => segment === other[i]);
  });
}

/**
 * Renders a path list the way a container definition spells it, so a refusal
 * names the configured and the actual key in one vocabulary.
 *
 * @param paths - The path lists
 * @returns A comma-separated rendering, for example `/tenantId, /region`
 * @since 0.2.0
 */
export function renderPaths(paths: readonly (readonly string[])[]): string {
  return paths.map(renderPartitionKeyPath).join(', ');
}
