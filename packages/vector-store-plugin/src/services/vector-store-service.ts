/**
 * The service registered under `CAPABILITIES.VECTOR_STORE`. Every argument is
 * validated here, once, before the adapter is called (plan §3.10); a refused
 * call never reaches the backend.
 *
 * @module
 */
import {
  VectorCollectionUnknownError,
  VectorOperationUnsupportedError,
  VectorRecordError,
  VectorScopeRequiredError,
} from '@setu-ts/common';
import type {
  IRequestContext,
  IVectorStore,
  IVectorStoreAdapter,
  VectorMatch,
  VectorQuery,
  VectorRecord,
  VectorReplaceOptions,
} from '@setu-ts/common';
import type { ResolvedCollection } from './collection-spec.ts';
import { validateFilter } from './filter-validation.ts';
import { MAX_TOP_K, shownName } from './limits.ts';
import {
  validateId,
  validateIds,
  validateRecords,
  validateScope,
  validateVector,
} from './record-validation.ts';

/**
 * How the store finds a request's scope: from the request's tenant, or one
 * fixed scope for a store used without multi-tenancy.
 *
 * @since 0.12.0
 */
export type VectorStoreTenancy =
  | 'required'
  | {
      /** The one scope every call through `scopeFor` uses. */
      readonly fixed: string;
    };

/** Validates every call, then delegates to the adapter. */
export class VectorStoreService implements IVectorStore {
  readonly #adapter: IVectorStoreAdapter;
  readonly #collections: ReadonlyMap<string, ResolvedCollection>;
  readonly #fixed: string | undefined;

  /**
   * @param adapter - The opened adapter
   * @param collections - The validated collections
   * @param tenancy - How `scopeFor` resolves a scope
   */
  constructor(
    adapter: IVectorStoreAdapter,
    collections: ReadonlyMap<string, ResolvedCollection>,
    tenancy: VectorStoreTenancy,
  ) {
    this.#adapter = adapter;
    this.#collections = collections;
    this.#fixed = tenancy === 'required' ? undefined : validateScope(tenancy.fixed);
  }

  /** @inheritdoc */
  scopeFor(ctx: IRequestContext): string {
    // A fixed scope applies whatever the request's tenant, so tenant and
    // tenant-less requests never share rows (plan §3.3).
    if (this.#fixed !== undefined) return this.#fixed;
    const tenant = ctx.request.tenant?.id;
    if (tenant === undefined) throw new VectorScopeRequiredError();
    return validateScope(tenant);
  }

  /** @inheritdoc */
  async upsert(collection: string, scope: string, records: readonly VectorRecord[]): Promise<void> {
    const resolved = this.#collection(collection);
    const validScope = validateScope(scope);
    const valid = validateRecords(records, resolved.spec.dimensions, resolved.fields);
    if (valid.length === 0) return;
    await this.#adapter.upsert(resolved.spec, validScope, valid);
  }

  /** @inheritdoc */
  async replaceSource(
    collection: string,
    scope: string,
    sourceId: string,
    records: readonly VectorRecord[],
    options?: VectorReplaceOptions,
  ): Promise<void> {
    const resolved = this.#collection(collection);
    const validScope = validateScope(scope);
    const validSource = validateId(sourceId, 'source id');
    const valid = validateRecords(records, resolved.spec.dimensions, resolved.fields);
    for (const record of valid) {
      if (record.sourceId !== validSource) {
        throw new VectorRecordError('every record passed to replaceSource must carry its sourceId');
      }
    }
    const version = validateVersion(options);
    if (version === undefined) {
      await this.#adapter.replaceSource(resolved.spec, validScope, validSource, valid);
      return;
    }
    if (this.#adapter.versionedReplace !== true) {
      throw new VectorOperationUnsupportedError(
        `${this.#adapter.name}: replaceSource cannot write a version on this backend`,
      );
    }
    await this.#adapter.replaceSource(resolved.spec, validScope, validSource, valid, version);
  }

  /** @inheritdoc */
  async query(
    collection: string,
    scope: string,
    query: VectorQuery,
  ): Promise<readonly VectorMatch[]> {
    const resolved = this.#collection(collection);
    const validScope = validateScope(scope);
    if (query === null || typeof query !== 'object') {
      throw new VectorRecordError('a query must be an object');
    }
    const { vector, topK, filter, minScore } = query;
    if (typeof topK !== 'number' || !Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) {
      throw new VectorRecordError(`topK must be an integer from 1 to ${MAX_TOP_K}`);
    }
    if (
      minScore !== undefined &&
      (typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < -1 || minScore > 1)
    ) {
      throw new VectorRecordError('minScore must be a finite number from -1 to 1');
    }
    const validQuery: VectorQuery = {
      vector: validateVector(vector, resolved.spec.dimensions),
      topK,
      ...(filter === undefined ? {} : { filter: validateFilter(filter, resolved.fields) }),
      ...(minScore === undefined ? {} : { minScore }),
    };
    return await this.#adapter.query(resolved.spec, validScope, validQuery);
  }

  /** @inheritdoc */
  async delete(collection: string, scope: string, ids: readonly string[]): Promise<void> {
    const resolved = this.#collection(collection);
    const validScope = validateScope(scope);
    const validIds = validateIds(ids);
    if (validIds.length === 0) return;
    await this.#adapter.delete(resolved.spec, validScope, validIds);
  }

  /** @inheritdoc */
  async deleteScope(collection: string, scope: string): Promise<void> {
    const resolved = this.#collection(collection);
    await this.#adapter.deleteScope(resolved.spec, validateScope(scope));
  }

  #collection(name: string): ResolvedCollection {
    const resolved = typeof name === 'string' ? this.#collections.get(name) : undefined;
    if (resolved === undefined) throw new VectorCollectionUnknownError(shownName(name));
    return resolved;
  }
}

/**
 * The version of a `replaceSource` call: absent, or a non-negative safe
 * integer. `NaN`, an infinity, a fraction or a negative number would make the
 * stored-version comparison accept or refuse everything, so each is refused.
 */
function validateVersion(options: VectorReplaceOptions | undefined): number | undefined {
  if (options === undefined) return undefined;
  if (options === null || typeof options !== 'object') {
    throw new VectorRecordError('replaceSource options must be an object');
  }
  const { version } = options;
  if (version === undefined) return undefined;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw new VectorRecordError('a replaceSource version must be a non-negative safe integer');
  }
  return version;
}
