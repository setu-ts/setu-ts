/**
 * A faithful in-memory stand-in for the `@azure/cosmos` client.
 *
 * Every behaviour below was MEASURED against the real emulator, because a
 * forgiving double is this repository's most repeated source of green-but-broken
 * code. The four that matter and are easy to get wrong:
 *
 * - a point read of a missing item **returns** `{ statusCode: 404, resource:
 *   undefined }` and does NOT throw;
 * - `delete`, `patch` and `replace` on a missing item **throw** `{ code: 404 }`;
 * - a `replace` whose `IfMatch` is stale throws `{ code: 412 }`;
 * - `create` of a duplicate id within one partition throws `{ code: 409 }`, and
 *   reading the definition of a container that does not exist throws
 *   `{ code: 404 }`.
 *
 * Query EVALUATION is deliberately not reimplemented: the emitted SQL is
 * asserted as text in `cosmos-query.test.ts` and executed for real in the
 * guarded emulator suite, so the fake scripts query results instead of pretending
 * to be a query engine.
 *
 * @module
 */
import type {
  CosmosBatchOperation,
  CosmosBatchResponse,
  CosmosContainerDefinition,
  CosmosFeedResponse,
  CosmosItemResponse,
  CosmosPartitionKeyValue,
  CosmosPatchOperation,
  CosmosQuerySpec,
  CosmosRequestOptions,
  ICosmosClient,
  ICosmosContainer,
  ICosmosDatabase,
  ICosmosItem,
  ICosmosItems,
  ICosmosQueryIterator,
} from '../../src/adapters/cosmos/cosmos-client-types.ts';

/** An error carrying the SDK's numeric `code`, which the adapter branches on. */
export class FakeCosmosError extends Error {
  /** The HTTP status the SDK reports. */
  readonly code: number;

  /**
   * Creates the error.
   *
   * @param code - The HTTP status
   * @param message - The diagnostic
   */
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** How one fake container is configured. */
export interface FakeContainerSpec {
  /** The partition-key paths the definition reports, leading slash included. */
  readonly partitionKeyPaths?: readonly string[];
  /** Seed documents, keyed by `<partitionKey>|<id>`. */
  readonly documents?: Record<string, Record<string, unknown>>;
}

/** Everything one fake run records, for assertions. */
export interface FakeCosmosRecorder {
  /** Every query spec the adapter issued, in order. */
  readonly queries: CosmosQuerySpec[];
  /** Every batch the adapter flushed, in order. */
  readonly batches: {
    readonly container: string;
    readonly partitionKey: CosmosPartitionKeyValue;
    readonly operations: readonly CosmosBatchOperation[];
  }[];
  /** How many times each container's definition was read. */
  readonly definitionReads: Record<string, number>;
  /** Every patch the adapter issued, in order. */
  readonly patches: (readonly CosmosPatchOperation[])[];
  /** Every replace the adapter issued, with its access condition. */
  readonly replaces: { readonly body: Record<string, unknown>; readonly ifMatch?: string }[];
}

/** Options for {@linkcode createFakeCosmosClient}. */
export interface FakeCosmosOptions {
  /** The containers this database serves, keyed by container id. */
  readonly containers: Record<string, FakeContainerSpec>;
  /** Scripted query results, consumed in order; an exhausted queue yields `[]`. */
  readonly queryResults?: Record<string, unknown>[][];
  /** When set, `database.read()` throws with this status. */
  readonly databaseReadStatus?: number;
  /** When set, a batch answers this overall code instead of 200. */
  readonly batchCode?: number;
  /**
   * Called after every point read has captured its result but before it
   * resolves — the seam a test uses to land a COMPETING write between an
   * adapter's read and its conditional replace, which is the only way to
   * reach the 412 path honestly.
   */
  readonly afterPointRead?: () => void;
}

/** The fake client plus the recorder its assertions read. */
export interface FakeCosmos {
  /** The client to inject. */
  readonly client: ICosmosClient;
  /** What the adapter did. */
  readonly recorder: FakeCosmosRecorder;
  /** The live document store, keyed `<container>|<partitionKey>|<id>`. */
  readonly documents: Map<string, Record<string, unknown>>;
}

/** Renders the store key for one document. */
function documentKey(
  container: string,
  partitionKey: CosmosPartitionKeyValue | undefined,
  id: string,
): string {
  return `${container}|${JSON.stringify(partitionKey ?? null)}|${id}`;
}

/**
 * Creates a fake Cosmos client over an in-memory store.
 *
 * @param options - The containers, seeds and scripted query results
 * @returns The client, its recorder and the live document store
 */
export function createFakeCosmosClient(options: FakeCosmosOptions): FakeCosmos {
  const documents = new Map<string, Record<string, unknown>>();
  const recorder: FakeCosmosRecorder = {
    queries: [],
    batches: [],
    definitionReads: {},
    patches: [],
    replaces: [],
  };
  const pending = [...(options.queryResults ?? [])];
  let etagCounter = 0;

  for (const [container, spec] of Object.entries(options.containers)) {
    for (const [key, document] of Object.entries(spec.documents ?? {})) {
      // Split at the LAST separator, so a hierarchical partition key written as
      // a JSON array literal survives; it is parsed back so the seeded key
      // matches the ARRAY a point read addresses it with.
      const cut = key.lastIndexOf('|');
      const rawKey = key.slice(0, cut);
      const id = key.slice(cut + 1);
      const partitionKey = rawKey.startsWith('[')
        ? JSON.parse(rawKey) as CosmosPartitionKeyValue
        : rawKey;
      documents.set(
        documentKey(container, partitionKey, id),
        { ...document, _etag: `etag-${++etagCounter}`, _rid: 'rid', _ts: 1 },
      );
    }
  }

  const makeItems = (container: string): ICosmosItems => ({
    create: (body) => {
      const id = body['id'] as string;
      const spec = options.containers[container] as FakeContainerSpec;
      const path = (spec.partitionKeyPaths?.[0] ?? '/id').slice(1);
      const key = documentKey(container, body[path] as CosmosPartitionKeyValue, id);
      if (documents.has(key)) {
        return Promise.reject(
          new FakeCosmosError(409, 'The document already exists in the collection.'),
        );
      }
      const stored = { ...body, _etag: `etag-${++etagCounter}`, _rid: 'rid', _ts: 1 };
      documents.set(key, stored);
      return Promise.resolve({ statusCode: 201, resource: { ...stored } });
    },
    query: (spec: CosmosQuerySpec): ICosmosQueryIterator<Record<string, unknown>> => {
      recorder.queries.push(spec);
      const rows = pending.shift() ?? [];
      return {
        fetchAll: (): Promise<CosmosFeedResponse<Record<string, unknown>>> =>
          Promise.resolve({ resources: rows }),
      };
    },
    batch: (operations, partitionKey): Promise<CosmosBatchResponse> => {
      recorder.batches.push({ container, partitionKey, operations });
      const code = options.batchCode ?? 200;
      return Promise.resolve({
        code,
        // Measured: a batch that did not apply answers 207 overall, with 424
        // ("dependency failed") for the operations the failure aborted.
        result: operations.map(() => ({ statusCode: code === 200 ? 201 : 424 })),
      });
    },
  });

  const makeItem = (
    container: string,
    id: string,
    partitionKey?: CosmosPartitionKeyValue,
  ): ICosmosItem => {
    const key = documentKey(container, partitionKey, id);
    return {
      read: (): Promise<CosmosItemResponse<Record<string, unknown>>> => {
        const found = documents.get(key);
        const captured = found === undefined ? undefined : { ...found };
        options.afterPointRead?.();
        // Measured: a missing item RETURNS a 404 envelope rather than throwing.
        return Promise.resolve(
          captured === undefined ? { statusCode: 404 } : { statusCode: 200, resource: captured },
        );
      },
      replace: (
        body: Record<string, unknown>,
        requestOptions?: CosmosRequestOptions,
      ): Promise<CosmosItemResponse<Record<string, unknown>>> => {
        recorder.replaces.push(
          requestOptions?.accessCondition === undefined
            ? { body }
            : { body, ifMatch: requestOptions.accessCondition.condition },
        );
        const found = documents.get(key);
        if (found === undefined) {
          return Promise.reject(new FakeCosmosError(404, 'Resource Not Found.'));
        }
        const condition = requestOptions?.accessCondition;
        if (condition !== undefined && condition.condition !== found['_etag']) {
          return Promise.reject(new FakeCosmosError(412, 'E-tag mismatch detected'));
        }
        const stored = { ...body, _etag: `etag-${++etagCounter}`, _rid: 'rid', _ts: 1 };
        documents.set(key, stored);
        return Promise.resolve({ statusCode: 200, resource: { ...stored } });
      },
      patch: (
        operations: readonly CosmosPatchOperation[],
      ): Promise<CosmosItemResponse<Record<string, unknown>>> => {
        recorder.patches.push(operations);
        const found = documents.get(key);
        if (found === undefined) {
          return Promise.reject(new FakeCosmosError(404, 'Resource Not Found.'));
        }
        const patched = { ...found };
        for (const operation of operations) {
          patched[operation.path.slice(1)] = operation.value;
        }
        patched['_etag'] = `etag-${++etagCounter}`;
        documents.set(key, patched);
        return Promise.resolve({ statusCode: 200, resource: { ...patched } });
      },
      delete: (): Promise<CosmosItemResponse<Record<string, unknown>>> => {
        if (!documents.has(key)) {
          // Measured: unlike a read, a delete of a missing item THROWS.
          return Promise.reject(new FakeCosmosError(404, 'Resource Not Found.'));
        }
        documents.delete(key);
        return Promise.resolve({ statusCode: 204 });
      },
    };
  };

  const makeContainer = (container: string): ICosmosContainer => ({
    items: makeItems(container),
    item: (id, partitionKey) => makeItem(container, id, partitionKey),
    read: (): Promise<CosmosItemResponse<CosmosContainerDefinition>> => {
      recorder.definitionReads[container] = (recorder.definitionReads[container] ?? 0) + 1;
      const spec = options.containers[container];
      if (spec === undefined) {
        return Promise.reject(
          new FakeCosmosError(404, `Collection '${container}' not found in database`),
        );
      }
      return Promise.resolve({
        statusCode: 200,
        resource: { partitionKey: { paths: spec.partitionKeyPaths ?? ['/id'] } },
      });
    },
  });

  const database: ICosmosDatabase = {
    container: makeContainer,
    read: (): Promise<CosmosItemResponse<Record<string, unknown>>> => {
      const status = options.databaseReadStatus;
      if (status !== undefined) {
        return Promise.reject(new FakeCosmosError(status, `Database read failed with ${status}`));
      }
      return Promise.resolve({ statusCode: 200, resource: {} });
    },
  };

  return { client: { database: () => database }, recorder, documents };
}
