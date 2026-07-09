// deno-lint-ignore-file require-await -- async methods must match real Drizzle instance interface
/**
 * Fake Drizzle database instance for unit testing the DrizzleAdapter.
 *
 * Honors the real Drizzle instance's $client.connect/$client.end/$client.transaction
 * and execute() shapes so adapter tests can exercise the connection lifecycle
 * without needing drizzle-orm installed or a real database.
 *
 * @module
 */

/**
 * Create a fake Drizzle database instance.
 *
 * @returns Fake Drizzle DB with $client and execute methods.
 */
export function createFakeDrizzleInstance(): {
  $client: {
    connect: () => Promise<void>;
    end: () => Promise<void>;
    transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  };
  execute: (values: unknown) => Promise<unknown>;
  connected: boolean;
  ended: boolean;
  executedValues: unknown[];
} {
  let connected = false;
  let ended = false;
  const executedValues: unknown[] = [];

  return {
    get connected() {
      return connected;
    },
    get ended() {
      return ended;
    },
    executedValues,
    $client: {
      async connect() {
        connected = true;
        ended = false;
      },
      async end() {
        ended = true;
        connected = false;
      },
      async transaction<T>(cb: (tx: unknown) => Promise<T>): Promise<T> {
        return cb({});
      },
    },
    async execute(values: unknown): Promise<unknown> {
      executedValues.push(values);
      return { rows: [] };
    },
  };
}
