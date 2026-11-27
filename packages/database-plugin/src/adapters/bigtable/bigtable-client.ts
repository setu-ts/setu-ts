/**
 * Inject-or-lazy loading for the optional Cloud Bigtable SDK, and the
 * adaptation of that SDK to the structural facade the adapter drives.
 *
 * An injected {@linkcode IBigtableClient} never imports the SDK. The lazy arm
 * imports the literal `@google-cloud/bigtable` specifier only when its
 * loader is used — literal because a computed specifier is unreachable by JSR's
 * static npm-compat rewrite, and `scripts/npm-specifier-audit.ts` refuses one.
 *
 * @module
 */
import { OptionalDependencyUnavailableError } from '@setu-ts/common';
import { requestBound } from '../request-bound.ts';
import type {
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
  /**
   * Further `Bigtable` constructor options, passed through to the SDK.
   * `projectId` and `apiEndpoint` given beside it win over the same keys here.
   */
  readonly clientOptions?: Readonly<Record<string, unknown>>;
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

/**
 * What the plugin read from the runtime environment for the lazy arm.
 *
 * Not on the exported configuration: an adapter built directly decides from
 * its options alone, and only the plugin reads the environment.
 *
 * @internal
 */
export interface BigtableEnvironmentFacts {
  /** `BIGTABLE_EMULATOR_HOST` is set. */
  readonly emulatorFromEnvironment?: boolean;
  /** `GOOGLE_CLOUD_UNIVERSE_DOMAIN` is set. */
  readonly universeFromEnvironment?: boolean;
}

/** The options handed to the native `Bigtable` constructor. */
type BigtableSdkClientOptions = Readonly<Record<string, unknown>> & { readonly projectId: string };

/** The native SDK's per-row write surface, as this adapter uses it. */
interface BigtableSdkRow {
  /** CheckAndMutateRow. Resolves to a one-element `[matched]` tuple. */
  filter(
    test: readonly unknown[],
    branches: {
      onMatch?: readonly unknown[];
      onNoMatch?: readonly unknown[];
      gaxOptions?: { timeout: number };
    },
  ): Promise<[boolean, ...unknown[]]>;
}

/** The native SDK's per-table surface, as this adapter uses it. */
interface BigtableReadStream {
  on(event: string, listener: (value?: unknown) => void): unknown;
  end(): void;
}

interface BigtableSdkTable {
  /** Streaming ReadRows permits the whole-call bound to stop resumption retries. */
  createReadStream?(options: unknown): BigtableReadStream;
  /** ReadRows. Resolves to a one-element tuple holding the row array. */
  getRows(options: unknown): Promise<[readonly BigtableSdkReadRow[], ...unknown[]]>;
  /** Returns the row handle for one key. */
  row(key: string): BigtableSdkRow;
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
  Bigtable: new (options: BigtableSdkClientOptions) => BigtableSdkClientInstance;
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
  return createBigtableSdkLoader(configuration, {});
}

/**
 * The lazy SDK loader with the plugin's environment facts.
 *
 * @param configuration - Settings passed to the native `Bigtable` constructor
 * @param environment - What the plugin read from the runtime environment
 * @returns A loader that imports and adapts the SDK when used, marked owned
 * @internal
 */
export function createBigtableSdkLoader(
  configuration: BigtableClientConfiguration,
  environment: BigtableEnvironmentFacts,
): BigtableClientLoader {
  return {
    owned: true,
    load: async (): Promise<IBigtableClient> => {
      let module: BigtableSdkModule;
      try {
        module = (await import('@google-cloud/bigtable')) as unknown as BigtableSdkModule;
      } catch (error) {
        throw new OptionalDependencyUnavailableError('@google-cloud/bigtable', {
          requiredBy: '@setu-ts/database-plugin',
          cause: error,
        });
      }
      return adaptBigtableSdk(module, configuration, environment);
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
 * Normalises one SDK row into the facade's read shape.
 *
 * @param row - The SDK row
 * @returns The facade row
 */
function adaptReadRow(row: BigtableSdkReadRow): BigtableReadRow {
  const data: Record<string, Record<string, { value: string }[]>> = {};
  for (const [family, qualifiers] of Object.entries(row.data ?? {})) {
    const adaptedFamily: Record<string, { value: string }[]> = {};
    for (const [qualifier, versions] of Object.entries(qualifiers)) {
      adaptedFamily[qualifier] = versions.map((cell) => ({ value: cellText(cell) }));
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
  if ('chain' in filter) return adaptChain(filter.chain);
  if ('interleave' in filter) {
    return { interleave: filter.interleave.map(adaptChain) };
  }
  if ('condition' in filter) {
    const { test, pass } = filter.condition;
    return {
      condition:
        pass === undefined
          ? { test: adaptChain(test) }
          : { test: adaptChain(test), pass: adaptChain(pass) },
    };
  }
  return filter;
}

/**
 * Translates a sequence of filters into ONE flat SDK filter array. The SDK's
 * `Filter.parse` reads each element's first key, so a nested chain (an array
 * inside the array) is refused as `Unknown filter: 0.`; a sequential chain
 * means the same as its elements in order, so it is spliced in.
 *
 * @param filters - The facade filters, applied in order
 * @returns The flat SDK filter array
 */
function adaptChain(filters: readonly BigtableFilter[]): unknown[] {
  return filters.flatMap((filter) =>
    'chain' in filter ? adaptChain(filter.chain) : [adaptFilter(filter)],
  );
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
  return adaptBigtableSdk(module, configuration, {});
}

/**
 * The options the native constructor receives.
 *
 * `clientOptions` spread first, so the explicit `projectId`/`apiEndpoint`
 * win. Against an emulator — named by the environment, or an endpoint with
 * no `sslCreds`, which is plaintext — two SDK defaults that need Google's
 * production services are turned off unless the caller set them: client-side
 * metrics export, and the universe-domain lookup that otherwise stalls the
 * first call while it resolves Google credentials. The universe default also
 * steps aside whenever a universe is configured, through `clientOptions` or
 * `GOOGLE_CLOUD_UNIVERSE_DOMAIN`, because the SDK lets an option override
 * that variable and gax refuses a call whose universe does not match.
 *
 * @param configuration - The adapter's client configuration
 * @param environment - What the plugin read from the runtime environment
 * @returns The constructor options
 * @internal
 */
function bigtableSdkOptions(
  configuration: BigtableClientConfiguration,
  environment: BigtableEnvironmentFacts,
): BigtableSdkClientOptions {
  const { clientOptions, ...top } = configuration;
  const effective = { ...clientOptions, ...top };
  const endpoint = effective['apiEndpoint'] !== undefined;
  const emulator = endpoint || environment.emulatorFromEnvironment === true;
  const plaintextEmulator =
    environment.emulatorFromEnvironment === true ||
    (endpoint && clientOptions?.['sslCreds'] === undefined);
  const universeConfigured =
    clientOptions?.['universeDomain'] !== undefined ||
    clientOptions?.['universe_domain'] !== undefined ||
    environment.universeFromEnvironment === true;
  return {
    ...effective,
    ...(emulator && clientOptions?.['metricsEnabled'] === undefined
      ? { metricsEnabled: false }
      : {}),
    ...(plaintextEmulator && !universeConfigured ? { universeDomain: 'googleapis.com' } : {}),
  };
}

/**
 * Adapts the native SDK with the plugin's environment facts.
 *
 * @param module - The native SDK module, or a structural test double
 * @param configuration - Settings supplied to the native client constructor
 * @param environment - What the plugin read from the runtime environment
 * @returns The facade the adapter drives
 * @internal
 */
export function adaptBigtableSdk(
  module: BigtableSdkModule,
  configuration: BigtableClientConfiguration,
  environment: BigtableEnvironmentFacts,
): IBigtableClient {
  const client = new module.Bigtable(bigtableSdkOptions(configuration, environment));
  return {
    instance: (id: string): IBigtableInstance => {
      const instance = client.instance(id);
      return {
        table: (tableId: string): IBigtableTable => {
          const table = instance.table(tableId);
          return {
            readRows: async (
              options: BigtableReadOptions,
              callOptions,
            ): Promise<BigtableReadRow[]> => {
              const timeout = callOptions?.timeoutMs;
              const readOptions = {
                ...adaptReadOptions(options),
                ...(timeout === undefined ? {} : { gaxOptions: { timeout } }),
              };
              const rows =
                timeout !== undefined && table.createReadStream !== undefined
                  ? await readStream(table.createReadStream(readOptions), timeout)
                  : (await table.getRows(readOptions))[0];
              return rows.map(adaptReadRow);
            },
            row: (key: string): IBigtableRow => {
              const row = table.row(key);
              return {
                conditionalMutate: async (test, branches, options): Promise<boolean> => {
                  const sdkBranches: {
                    onMatch?: unknown[];
                    onNoMatch?: unknown[];
                    gaxOptions?: { timeout: number };
                  } = {};
                  if (options?.timeoutMs !== undefined)
                    sdkBranches.gaxOptions = { timeout: options.timeoutMs };
                  if (branches.onMatch !== undefined) {
                    sdkBranches.onMatch = branches.onMatch.map(adaptMutation);
                  }
                  if (branches.onNoMatch !== undefined) {
                    sdkBranches.onNoMatch = branches.onNoMatch.map(adaptMutation);
                  }
                  const [matched] = await row.filter(adaptChain(test), sdkBranches);
                  return matched === true;
                },
              };
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

/** Ends a whole streaming call at its deadline, including SDK resumption retries. */
function readStream(
  stream: BigtableReadStream,
  timeout: number,
): Promise<readonly BigtableSdkReadRow[]> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(Math.ceil(timeout));
    const rows: BigtableSdkReadRow[] = [];
    let settled = false;
    const abort = (): void => {
      if (settled) return;
      settled = true;
      reject(
        Object.assign(new Error('Bigtable ReadRows whole-call deadline exceeded'), {
          code: 4,
          cause: signal.reason,
        }),
      );
      stream.end();
    };
    signal.addEventListener('abort', abort, { once: true });
    stream.on('data', (row) => {
      if (!settled) rows.push(row as BigtableSdkReadRow);
    });
    stream.on('error', (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(rows);
    });
  });
}

/** Maps facade deadlines to the driver and converts bounded gRPC expiries to 504. @internal */
export function boundBigtableClient(client: IBigtableClient, timeout: number): IBigtableClient {
  const callOptions = timeout === 0 ? {} : { timeoutMs: timeout };
  return {
    close: () => client.close(),
    instance: (id) => ({
      table: (name) => {
        const table = client.instance(id).table(name);
        return {
          readRows: (options) =>
            requestBound(timeout, () => table.readRows(options, callOptions), true),
          row: (key) => ({
            conditionalMutate: (test, branches) =>
              requestBound(
                timeout,
                () => table.row(key).conditionalMutate(test, branches, callOptions),
                true,
              ),
          }),
        };
      },
    }),
  };
}
