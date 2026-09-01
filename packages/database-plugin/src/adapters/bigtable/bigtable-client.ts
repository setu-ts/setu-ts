/**
 * Inject-or-lazy loading for the optional Cloud Bigtable SDK, and the
 * adaptation of that SDK to the structural facade the adapter drives.
 *
 * An injected {@linkcode IBigtableClient} never imports the SDK. The lazy arm
 * imports the literal `npm:@google-cloud/bigtable@^6` specifier only when its
 * loader is used — literal because a computed specifier is unreachable by JSR's
 * static npm-compat rewrite, and `scripts/npm-specifier-audit.ts` refuses one.
 *
 * @module
 */
import type {
  BigtableEntry,
  BigtableFilter,
  BigtableMutation,
  BigtableReadOptions,
  BigtableReadRow,
  BigtableRowData,
  IBigtableClient,
  IBigtableInstance,
  IBigtableRow,
  IBigtableTable,
} from './bigtable-client-types.ts';

/**
 * Client construction settings consumed by the lazy SDK arm.
 *
 * @since 0.2.0
 */
export interface BigtableClientConfiguration {
  /** The GCP project the instance lives in. */
  readonly projectId: string;
  /**
   * An explicit API endpoint, such as `127.0.0.1:8086` for `cbtemulator`.
   *
   * Measured: an endpoint alone reaches the emulator with no
   * `BIGTABLE_EMULATOR_HOST` and no credentials, which is why the adapter
   * takes it as an option rather than reading the environment.
   */
  readonly apiEndpoint?: string;
}

/** The native SDK's per-row write surface, as this adapter uses it. */
interface BigtableSdkRow {
  /** CheckAndMutateRow. Resolves to a one-element `[matched]` tuple. */
  filter(
    test: readonly unknown[],
    branches: { onMatch?: readonly unknown[]; onNoMatch?: readonly unknown[] },
  ): Promise<[boolean, ...unknown[]]>;
}

/** The native SDK's per-table surface, as this adapter uses it. */
interface BigtableSdkTable {
  /** ReadRows. Resolves to a one-element tuple holding the row array. */
  getRows(options: unknown): Promise<[readonly BigtableSdkReadRow[], ...unknown[]]>;
  /** Returns the row handle for one key. */
  row(key: string): BigtableSdkRow;
  /** MutateRows. */
  mutate(entries: readonly unknown[]): Promise<unknown>;
}

/** One row as the native SDK returns it. */
interface BigtableSdkReadRow {
  /** The row key. */
  readonly id: string;
  /** The row's cells, `family → qualifier → versions`. */
  readonly data?: Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>>;
}

/** The native SDK's per-instance surface. */
interface BigtableSdkInstance {
  /** Returns the table handle for one id. */
  table(id: string): BigtableSdkTable;
}

/** The native SDK's client. */
interface BigtableSdkClientInstance {
  /** Returns the instance handle for one id. */
  instance(id: string): BigtableSdkInstance;
  /** Releases the gRPC channels. */
  close(): Promise<unknown>;
}

/**
 * The native `@google-cloud/bigtable` module shape adapted by the lazy arm.
 *
 * Deliberately structural, so a test double implements it without importing
 * the optional SDK.
 *
 * @since 0.2.0
 */
export interface BigtableSdkModule {
  /** The Bigtable client constructor. */
  Bigtable: new (configuration: BigtableClientConfiguration) => BigtableSdkClientInstance;
}

/** The deferred client-resolution seam the adapter lifecycle drives. */
export interface BigtableClientLoader {
  /** Resolves a client without forcing the injected arm through an SDK import. */
  load(): Promise<IBigtableClient>;
  /**
   * Whether the loader constructed the client itself.
   *
   * `disconnect()` closes only a client it created: closing an injected one
   * would tear down gRPC channels the application still owns.
   */
  readonly owned: boolean;
}

/**
 * Creates the no-import arm of the client seam.
 *
 * @param client - An application-owned structural client facade
 * @returns A loader resolving the supplied client unchanged, marked unowned
 * @since 0.2.0
 */
export function createInjectedBigtableLoader(client: IBigtableClient): BigtableClientLoader {
  return { load: (): Promise<IBigtableClient> => Promise.resolve(client), owned: false };
}

/**
 * Creates the lazy SDK loader.
 *
 * The literal import sits inside `load()`, so an application that injects a
 * client never resolves the optional SDK.
 *
 * @param configuration - Settings passed to the native `Bigtable` constructor
 * @returns A loader that imports and adapts the SDK when used, marked owned
 * @since 0.2.0
 */
export function createLazyBigtableLoader(
  configuration: BigtableClientConfiguration,
): BigtableClientLoader {
  return {
    owned: true,
    load: async (): Promise<IBigtableClient> => {
      const module = await import('npm:@google-cloud/bigtable@^6') as unknown as BigtableSdkModule;
      return adaptBigtableSdkModule(module, configuration);
    },
  };
}

/**
 * Reads one cell's value as text.
 *
 * A cell this adapter wrote is a string, but a table written elsewhere may
 * carry raw bytes, which the SDK surfaces as a `Buffer`/`Uint8Array`. Decoding
 * it here is what lets the value codec's interop path see the text a foreign
 * producer actually stored.
 *
 * @param cell - One version as the SDK returned it
 * @returns The cell text, or `''` when the version carries no readable value
 */
function cellText(cell: unknown): string {
  if (typeof cell !== 'object' || cell === null) return '';
  const value = (cell as { value?: unknown }).value;
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value === undefined || value === null) return '';
  return String(value);
}

/**
 * Reads one cell's timestamp, when the SDK reported one.
 *
 * @param cell - One version as the SDK returned it
 * @returns The timestamp string, or `undefined`
 */
function cellTimestamp(cell: unknown): string | undefined {
  if (typeof cell !== 'object' || cell === null) return undefined;
  const timestamp = (cell as { timestamp?: unknown }).timestamp;
  return typeof timestamp === 'string' ? timestamp : undefined;
}

/**
 * Normalises one SDK row into the facade's read shape.
 *
 * @param row - The SDK row
 * @returns The facade row
 */
function adaptReadRow(row: BigtableSdkReadRow): BigtableReadRow {
  const data: Record<string, Record<string, { value: string; timestamp?: string }[]>> = {};
  for (const [family, qualifiers] of Object.entries(row.data ?? {})) {
    const adaptedFamily: Record<string, { value: string; timestamp?: string }[]> = {};
    for (const [qualifier, versions] of Object.entries(qualifiers)) {
      adaptedFamily[qualifier] = versions.map((cell) => {
        const timestamp = cellTimestamp(cell);
        return timestamp === undefined
          ? { value: cellText(cell) }
          : { value: cellText(cell), timestamp };
      });
    }
    data[family] = adaptedFamily;
  }
  return { key: row.id, data: data as BigtableRowData };
}

/**
 * Translates one facade filter into the SDK's filter shape.
 *
 * The SDK spells a chain as a bare array, so `chain` unwraps rather than
 * mapping to a named member; `interleave` keeps its name and maps each arm.
 *
 * @param filter - The facade filter
 * @returns The SDK filter
 */
function adaptFilter(filter: BigtableFilter): unknown {
  if ('chain' in filter) return filter.chain.map(adaptFilter);
  if ('interleave' in filter) {
    return { interleave: filter.interleave.map((arm) => arm.map(adaptFilter)) };
  }
  if ('condition' in filter) {
    const { test, pass } = filter.condition;
    return {
      condition: pass === undefined
        ? { test: test.map(adaptFilter) }
        : { test: test.map(adaptFilter), pass: pass.map(adaptFilter) },
    };
  }
  return filter;
}

/**
 * Translates one facade mutation into the SDK's mutation shape.
 *
 * @param mutation - The facade mutation
 * @returns The SDK mutation
 */
function adaptMutation(mutation: BigtableMutation): unknown {
  return mutation.method === 'delete'
    ? { method: 'delete' }
    : { method: 'insert', data: mutation.data };
}

/**
 * Translates a facade read request into the SDK's `getRows` options.
 *
 * `keys` and `ranges` are set only when non-empty: the SDK reads the whole
 * table when neither is present, so passing an empty array would turn
 * "nothing matches" into "everything matches". The planner short-circuits the
 * genuinely-empty case before it reaches here.
 *
 * @param options - The facade read request
 * @returns The SDK options object
 */
function adaptReadOptions(options: BigtableReadOptions): Record<string, unknown> {
  const sdk: Record<string, unknown> = {};
  if (options.keys !== undefined && options.keys.length > 0) sdk.keys = [...options.keys];
  if (options.ranges !== undefined && options.ranges.length > 0) {
    sdk.ranges = options.ranges.map((range) => {
      const adapted: Record<string, unknown> = {};
      if (range.start !== undefined) adapted.start = { ...range.start };
      if (range.end !== undefined) adapted.end = { ...range.end };
      return adapted;
    });
  }
  if (options.filter !== undefined) sdk.filter = adaptFilter(options.filter);
  if (options.limit !== undefined) sdk.limit = options.limit;
  return sdk;
}

/**
 * Adapts a native Bigtable SDK module to the structural client facade.
 *
 * @param module - The native SDK module, or a structural test double
 * @param configuration - Settings supplied to the native client constructor
 * @returns The facade the adapter drives
 * @since 0.2.0
 */
export function adaptBigtableSdkModule(
  module: BigtableSdkModule,
  configuration: BigtableClientConfiguration,
): IBigtableClient {
  const client = new module.Bigtable(configuration);
  return {
    instance: (id: string): IBigtableInstance => {
      const instance = client.instance(id);
      return {
        table: (tableId: string): IBigtableTable => {
          const table = instance.table(tableId);
          return {
            readRows: async (options: BigtableReadOptions): Promise<BigtableReadRow[]> => {
              const [rows] = await table.getRows(adaptReadOptions(options));
              return rows.map(adaptReadRow);
            },
            row: (key: string): IBigtableRow => {
              const row = table.row(key);
              return {
                conditionalMutate: async (test, branches): Promise<boolean> => {
                  const sdkBranches: { onMatch?: unknown[]; onNoMatch?: unknown[] } = {};
                  if (branches.onMatch !== undefined) {
                    sdkBranches.onMatch = branches.onMatch.map(adaptMutation);
                  }
                  if (branches.onNoMatch !== undefined) {
                    sdkBranches.onNoMatch = branches.onNoMatch.map(adaptMutation);
                  }
                  const [matched] = await row.filter(test.map(adaptFilter), sdkBranches);
                  return matched === true;
                },
              };
            },
            mutate: async (entries: readonly BigtableEntry[]): Promise<void> => {
              if (entries.length === 0) return;
              await table.mutate(
                entries.map((entry) => ({
                  key: entry.key,
                  ...(adaptMutation(entry.mutation) as Record<string, unknown>),
                })),
              );
            },
          };
        },
      };
    },
    close: async (): Promise<void> => {
      await client.close();
    },
  };
}
