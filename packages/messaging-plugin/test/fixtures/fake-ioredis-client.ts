import type { IRedisStreamsClient } from '../../src/interfaces/index.ts';

/**
 * Options for configuring the fake Redis Streams client.
 */
export interface FakeRedisOptions {
  /** Whether to simulate BUSYGROUP on XGROUP CREATE. */
  simulateBusyGroup?: boolean;
  /** Whether to reject on XADD. */
  rejectXadd?: boolean;
  /** Whether to reject on XREADGROUP. */
  rejectXreadgroup?: boolean;
  /** Pre-seeded messages for XREADGROUP. */
  seededMessages?: Array<{ id: string; payload: string }>;
}

/**
 * Fake ioredis client for testing RedisStreamsBroker.
 *
 * Records all method calls and simulates Redis Streams behavior.
 */
export class FakeRedisStreamsClient implements IRedisStreamsClient {
  #options: FakeRedisOptions;
  #streams: Map<string, Array<{ id: string; payload: string }>>;
  #groups: Map<string, Set<string>>; // stream -> consumer groups
  #pending: Map<string, Map<string, { groupId: string; messageId: string }>>; // stream -> groupId -> messageId -> pending
  #calls: Array<{ method: string; args: unknown[] }>;
  #quitCalled = false;
  #connectCalled = false;

  constructor(options: FakeRedisOptions = {}) {
    this.#options = options;
    this.#streams = new Map();
    this.#groups = new Map();
    this.#pending = new Map();
    this.#calls = [];
  }

  /**
   * Records a method call for inspection.
   */
  #record(method: string, args: unknown[]): void {
    this.#calls.push({ method, args: [...args] });
  }

  /**
   * All recorded method calls.
   */
  get calls(): Array<{ method: string; args: unknown[] }> {
    return [...this.#calls];
  }

  /**
   * Whether quit() has been called.
   */
  get quitCalled(): boolean {
    return this.#quitCalled;
  }

  /**
   * Whether connect() has been called.
   */
  get connectCalled(): boolean {
    return this.#connectCalled;
  }

  /**
   * Clear all recorded calls and state.
   */
  reset(): void {
    this.#calls = [];
    this.#quitCalled = false;
    this.#connectCalled = false;
  }

  /**
   * Reset stream data.
   */
  resetStreams(): void {
    this.#streams.clear();
    this.#groups.clear();
    this.#pending.clear();
  }

  // deno-lint-ignore require-await
  async xadd(
    name: string,
    id: string,
    data: string | Array<string>,
    ..._args: string[]
  ): Promise<string> {
    this.#record('xadd', [name, id, data]);

    if (this.#options.rejectXadd) {
      throw new Error('XADD failed');
    }

    if (!this.#streams.has(name)) {
      this.#streams.set(name, []);
    }
    const stream = this.#streams.get(name)!;

    // Parse payload from data - could be string or array
    let payload: string;
    if (typeof data === 'string') {
      payload = data;
    } else {
      // Array format: ['field1', 'value1', 'field2', 'value2', ...]
      const payloadIdx = data.indexOf('payload');
      payload = payloadIdx >= 0 && payloadIdx + 1 < data.length ? data[payloadIdx + 1] : '';
    }

    const entryId = id === '*' ? `0-${stream.length}` : id;
    stream.push({ id: entryId, payload });

    return entryId;
  }

  // deno-lint-ignore require-await
  async xgroup(
    command: 'CREATE' | 'DELETE' | 'SETID',
    ...args: string[]
  ): Promise<string | 'OK'> {
    this.#record('xgroup', [command, ...args]);

    if (command === 'CREATE') {
      const stream = args[0];
      const group = args[1];

      if (!this.#groups.has(stream)) {
        this.#groups.set(stream, new Set());
      }
      const groups = this.#groups.get(stream)!;

      if (groups.has(group)) {
        if (this.#options.simulateBusyGroup) {
          const err = new Error('BUSYGROUP Consumer Group name already exists') as Error & {
            code?: string;
          };
          err.code = 'BUSYGROUP';
          throw err;
        }
        return 'OK';
      }

      groups.add(group);

      // Initialize pending map for this group
      if (!this.#pending.has(stream)) {
        this.#pending.set(stream, new Map());
      }

      return 'OK';
    }

    if (command === 'DELETE') {
      const stream = args[0];
      const group = args[1];

      if (this.#groups.has(stream)) {
        this.#groups.get(stream)!.delete(group);
      }
      return 'OK';
    }

    if (command === 'SETID') {
      return 'OK';
    }

    return 'OK';
  }

  // deno-lint-ignore require-await
  async xreadgroup(...args: string[]): Promise<unknown[][] | null> {
    this.#record('xreadgroup', args);

    if (this.#options.rejectXreadgroup) {
      throw new Error('XREADGROUP failed');
    }

    // Parse arguments: GROUP group consumer COUNT N BLOCK M STREAMS stream id
    const groupIdx = args.indexOf('GROUP');
    if (groupIdx === -1) {
      return null;
    }

    const group = args[groupIdx + 1];
    const streamIdx = args.indexOf('STREAMS');
    const stream = args[streamIdx + 1];

    // Return seeded messages first (for testing)
    if (this.#options.seededMessages && this.#options.seededMessages.length > 0) {
      const result: unknown[][] = [];
      for (const msg of this.#options.seededMessages) {
        result.push([msg.id, ['payload', msg.payload]]);
      }
      // Clear seeded messages after returning them once
      this.#options.seededMessages = [];
      return result;
    }

    if (!this.#streams.has(stream)) {
      return null;
    }

    const streamData = this.#streams.get(stream)!;

    // Get messages after the last ID (simulated as '>')
    // For simplicity, return all messages not yet acked by this group
    const result: unknown[][] = [];

    // Return new messages (not yet acked)
    const streamPending = this.#pending.get(stream);
    for (const entry of streamData) {
      const key = `${group}:${entry.id}`;
      if (!streamPending || !streamPending.has(key)) {
        result.push([entry.id, ['payload', entry.payload]]);
        // Mark as pending after returning
        if (!streamPending) {
          this.#pending.set(stream, new Map());
        }
        this.#pending.get(stream)!.set(key, { groupId: group, messageId: entry.id });
      }
    }

    return result.length > 0 ? result : null;
  }

  // deno-lint-ignore require-await
  async xack(name: string, group: string, ...ids: string[]): Promise<number> {
    this.#record('xack', [name, group, ...ids]);

    if (!this.#pending.has(name)) {
      this.#pending.set(name, new Map());
    }
    const streamPending = this.#pending.get(name)!;

    let acked = 0;
    for (const id of ids) {
      const key = `${group}:${id}`;
      if (streamPending.has(key)) {
        streamPending.delete(key);
        acked++;
      } else {
        // Mark as pending for future ack
        streamPending.set(key, { groupId: group, messageId: id });
        acked++;
      }
    }

    return acked;
  }

  // deno-lint-ignore require-await
  async quit(): Promise<void> {
    this.#record('quit', []);
    this.#quitCalled = true;
  }

  // deno-lint-ignore require-await
  async connect(): Promise<void> {
    this.#record('connect', []);
    this.#connectCalled = true;
  }
}
