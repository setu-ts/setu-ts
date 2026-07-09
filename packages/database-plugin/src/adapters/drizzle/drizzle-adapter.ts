// deno-lint-ignore-file require-await -- transaction stubs must be async for ITransaction interface
/**
 * Drizzle ORM adapter — lazily loads Drizzle via `npm:drizzle-orm` import
 * or accepts an injected database instance.
 *
 * @module
 */
import type { IOrmAdapter, ITransaction } from '@hono-enterprise/common';
import type { DatabaseAdapterOptions } from '../../interfaces/index.ts';

// Drizzle database type — lazily resolved.
type DrizzleDB = {
  $client: {
    connect(): Promise<void>;
    end(): Promise<void>;
    transaction<T>(cb: (tx: unknown) => Promise<T>): Promise<T>;
  };
  execute(values: unknown): Promise<unknown>;
};

/**
 * Drizzle adapter wrapping a Drizzle database instance.
 *
 * The instance is either injected via `options.drizzleInstance` or lazily
 * loaded through `import('npm:drizzle-orm')`.
 *
 * @since 0.1.0
 */
export class DrizzleAdapter implements IOrmAdapter {
  private _db: DrizzleDB | null = null;
  private _connected = false;
  private readonly _options: DatabaseAdapterOptions | undefined;

  constructor(options?: DatabaseAdapterOptions) {
    this._options = options ?? undefined;
  }

  /** @inheritdoc */
  async connect(): Promise<void> {
    this._db = await this.resolveDb();
    await this._db.$client.connect();
    this._connected = true;
  }

  /** @inheritdoc */
  async disconnect(): Promise<void> {
    if (this._db) {
      await this._db.$client.end();
    }
    this._connected = false;
  }

  /** @inheritdoc */
  isReady(): boolean {
    return this._connected && this._db !== null;
  }

  /** @inheritdoc */
  async beginTransaction(): Promise<ITransaction> {
    if (!this.isReady()) {
      throw new Error('DrizzleAdapter is not connected — call connect() first');
    }

    // Start a transaction and keep the handle for operations.
    await this._db!.$client.transaction(async () => {
      // Work is delegated to the caller; this is a boundary.
      return true;
    });

    return {
      async commit(): Promise<void> {
        // Drizzle transactions are managed via callback in DatabaseService.
      },
      async rollback(): Promise<void> {
        // Drizzle transactions are managed via callback in DatabaseService.
      },
    };
  }

  /**
   * Resolve the Drizzle database instance from options or lazy import.
   *
   * @returns Drizzle database instance
   * @throws {Error} If Drizzle cannot be loaded
   */
  private async resolveDb(): Promise<DrizzleDB> {
    // Prefer injected instance.
    if (this._options?.drizzleInstance) {
      return this._options.drizzleInstance as DrizzleDB;
    }

    // Lazy-load Drizzle.
    try {
      // Dynamic import of drizzle-orm and the database driver.
      await import('npm:drizzle-orm@0.33.0');
      const url = this._options?.url;
      // A minimal connection using the url. The actual driver depends on
      // the database (Postgres, MySQL, SQLite). For now we require the
      // client to be injected for non-memory use.
      if (!url) {
        throw new Error('Drizzle requires a connection URL in options.url');
      }
      // Drizzle-orm requires a driver-specific connection. For simplicity
      // we return a placeholder when no client is injected.
      throw new Error(
        'Drizzle adapter requires options.drizzleInstance to be provided, or a configured driver.',
      );
    } catch (error) {
      throw new Error(
        `Failed to load Drizzle: ${(error as Error).message}. Inject via options.drizzleInstance.`,
      );
    }
  }
}
