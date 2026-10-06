import type { IRedisStreamsClient } from '../../src/interfaces/index.ts';

/** Redis RESP2 semantics measured by .tmp/probe-redis.ts on Redis 7.4. */
export interface FakeRedisOptions {
  simulateBusyGroup?: boolean;
  rejectXadd?: boolean;
  rejectXreadgroup?: boolean;
  /** Clock shared with the deterministic runtime. */
  now?: () => number;
  /** Redis 6.2 returns a null slot for a successfully claimed trimmed entry. */
  trimmedClaimReply?: 'null';
  seededMessages?: Array<
    { id: string; payload: string; fields?: Readonly<Record<string, string>> }
  >;
}
interface Pending {
  id: string;
  owner: string;
  deliveredAt: number;
  deliveries: number;
}
interface Group {
  delivered: Set<string>;
  pending: Map<string, Pending>;
  consumers: Map<string, { seenAt: number; activeAt: number }>;
}

/** Stateful fake: per-group PEL, atomic idle claims, and destructive DELCONSUMER. */
export class FakeRedisStreamsClient implements IRedisStreamsClient {
  #options: FakeRedisOptions;
  #streams = new Map<string, Array<[string, string[]]>>();
  #groups = new Map<string, Map<string, Group>>();
  #calls: Array<{ method: string; args: unknown[] }> = [];
  #sequence = 0;
  #quitCalled = false;
  #connectCalled = false;
  constructor(options: FakeRedisOptions = {}) {
    this.#options = options;
  }
  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
  #record(method: string, args: unknown[]): void {
    this.#calls.push({ method, args: [...args] });
  }
  get calls(): Array<{ method: string; args: unknown[] }> {
    return [...this.#calls];
  }
  get quitCalled(): boolean {
    return this.#quitCalled;
  }
  get connectCalled(): boolean {
    return this.#connectCalled;
  }
  reset(): void {
    this.#calls = [];
    this.#quitCalled = false;
    this.#connectCalled = false;
  }
  resetStreams(): void {
    this.#streams.clear();
    this.#groups.clear();
  }
  #group(topic: string, group: string): Group {
    const state = this.#groups.get(topic)?.get(group);
    if (!state) throw new Error('NOGROUP');
    return state;
  }
  #touch(group: Group, consumer: string, active: boolean): void {
    const previous = group.consumers.get(consumer);
    group.consumers.set(consumer, {
      seenAt: this.#now(),
      activeAt: active ? this.#now() : previous?.activeAt ?? -1,
    });
  }
  // deno-lint-ignore require-await
  async xadd(
    name: string,
    id: string,
    data: string | string[],
    ...args: string[]
  ): Promise<string> {
    this.#record('xadd', [name, id, data, ...args]);
    if (this.#options.rejectXadd) throw new Error('XADD failed');
    const parts = [id, ...(typeof data === 'string' ? [data] : data), ...args];
    const star = parts.indexOf('*');
    const limited = id === 'MAXLEN';
    const actualId = limited ? parts[star] : id;
    const fields = parts.slice(limited ? star + 1 : 1);
    const entryId = actualId === '*' ? `0-${this.#sequence++}` : actualId;
    const stream = this.#streams.get(name) ?? [];
    stream.push([entryId, fields]);
    // A deterministic exact trim is within the approximate retention contract.
    if (limited) stream.splice(0, Math.max(0, stream.length - Number(parts[2])));
    this.#streams.set(name, stream);
    return entryId;
  }
  // deno-lint-ignore require-await
  async xgroup(
    command: 'CREATE' | 'DELETE' | 'SETID' | 'DELCONSUMER',
    ...args: string[]
  ): Promise<string | number> {
    this.#record('xgroup', [command, ...args]);
    const [topic, group, consumer] = args;
    if (command === 'CREATE') {
      const groups = this.#groups.get(topic) ?? new Map<string, Group>();
      if (groups.has(group)) throw new Error('BUSYGROUP Consumer Group name already exists');
      const delivered = new Set<string>();
      if (args[2] === '$') { for (const [id] of this.#streams.get(topic) ?? []) delivered.add(id); }
      groups.set(group, { delivered, pending: new Map(), consumers: new Map() });
      this.#groups.set(topic, groups);
      this.#streams.set(topic, this.#streams.get(topic) ?? []);
      return 'OK';
    }
    if (command === 'DELCONSUMER') {
      const state = this.#group(topic, group);
      let dropped = 0;
      for (const [id, p] of state.pending) {
        if (p.owner === consumer) {
          state.pending.delete(id);
          dropped++;
        }
      }
      state.consumers.delete(consumer);
      return dropped;
    }
    if (command === 'DELETE') this.#groups.get(topic)?.delete(group);
    return 'OK';
  }
  // deno-lint-ignore require-await
  async xreadgroup(...args: string[]): Promise<unknown[][] | null> {
    this.#record('xreadgroup', args);
    if (this.#options.rejectXreadgroup) throw new Error('XREADGROUP failed');
    const gi = args.indexOf('GROUP');
    if (gi < 0) return null;
    const [group, owner] = args.slice(gi + 1);
    const topic = args[args.indexOf('STREAMS') + 1];
    const state = this.#group(topic, group);
    const stream = this.#streams.get(topic)!;
    for (const msg of this.#options.seededMessages ?? []) {
      stream.push([msg.id, ['payload', msg.payload, ...Object.entries(msg.fields ?? {}).flat()]]);
    }
    this.#options.seededMessages = [];
    const ci = args.indexOf('COUNT');
    const count = ci < 0 ? Infinity : Number(args[ci + 1]);
    const entries = stream.filter(([id]) => !state.delivered.has(id)).slice(0, count);
    this.#touch(state, owner, entries.length > 0);
    for (const [id] of entries) {
      state.delivered.add(id);
      state.pending.set(id, { id, owner, deliveredAt: this.#now(), deliveries: 1 });
    }
    return entries.length ? [[topic, entries]] : null;
  }
  // deno-lint-ignore require-await
  async xpending(...args: string[]): Promise<Array<[string, string, number, number]>> {
    this.#record('xpending', args);
    const [topic, group] = args;
    const filtered = args[2] === 'IDLE';
    const threshold = filtered ? Number(args[3]) : 0;
    const [start, end, count, owner] = args.slice(filtered ? 4 : 2);
    const numericId = (id: string): bigint => {
      const [a, b] = id.split('-');
      return BigInt(a) * 1000000n + BigInt(b);
    };
    return [...this.#group(topic, group).pending.values()]
      .sort((a, b) => numericId(a.id) < numericId(b.id) ? -1 : 1)
      .filter((p) =>
        this.#now() - p.deliveredAt >= threshold &&
        (owner === undefined || p.owner === owner) &&
        (start === '-' || (start.startsWith('(')
          ? numericId(p.id) > numericId(start.slice(1))
          : numericId(p.id) >= numericId(start))) &&
        (end === '+' || numericId(p.id) <= numericId(end))
      )
      .slice(0, Number(count))
      .map((p) => [p.id, p.owner, this.#now() - p.deliveredAt, p.deliveries]);
  }
  // deno-lint-ignore require-await
  async xclaim(...args: string[]): Promise<Array<[string, string[]] | null>> {
    this.#record('xclaim', args);
    const [topic, group, owner, minIdle, ...ids] = args;
    const state = this.#group(topic, group);
    this.#touch(state, owner, false);
    const entries: Array<[string, string[]] | null> = [];
    for (const id of ids) {
      const pending = state.pending.get(id);
      if (!pending || this.#now() - pending.deliveredAt < Number(minIdle)) continue;
      const entry = this.#streams.get(topic)?.find(([entryId]) => entryId === id);
      if (!entry) {
        if (this.#options.trimmedClaimReply === 'null') {
          pending.owner = owner;
          pending.deliveredAt = this.#now();
          pending.deliveries++;
          entries.push(null);
        } else state.pending.delete(id);
        continue;
      }
      pending.owner = owner;
      pending.deliveredAt = this.#now();
      pending.deliveries++;
      entries.push(entry);
      this.#touch(state, owner, true);
    }
    return entries;
  }
  // deno-lint-ignore require-await
  async xinfo(...args: string[]): Promise<unknown[][]> {
    this.#record('xinfo', args);
    const [, topic, group] = args;
    const state = this.#group(topic, group);
    return [...state.consumers].map(([name, times]) => [
      'name',
      name,
      'pending',
      [...state.pending.values()].filter((p) => p.owner === name).length,
      'idle',
      this.#now() - times.seenAt,
      'inactive',
      times.activeAt < 0 ? -1 : this.#now() - times.activeAt,
    ]);
  }
  // deno-lint-ignore require-await
  async call(command: string, ...args: string[]): Promise<unknown> {
    this.#record('call', [command, ...args]);
    if (command !== 'EVAL') throw new Error('Unsupported command');
    const [, , topic, group, self, threshold] = args;
    const state = this.#group(topic, group);
    let removed = 0;
    // No await between snapshot and mutation, matching Redis script atomicity.
    for (const [name, times] of state.consumers) {
      const pending = [...state.pending.values()].filter((p) => p.owner === name).length;
      const inactive = this.#now() - (times.activeAt < 0 ? times.seenAt : times.activeAt);
      if (name !== self && pending === 0 && inactive > Number(threshold)) {
        state.consumers.delete(name);
        this.#record('xgroup', ['DELCONSUMER', topic, group, name]);
        removed++;
      }
    }
    return removed;
  }
  // deno-lint-ignore require-await
  async xack(topic: string, group: string, ...ids: string[]): Promise<number> {
    this.#record('xack', [topic, group, ...ids]);
    let count = 0;
    for (const id of ids) if (this.#group(topic, group).pending.delete(id)) count++;
    return count;
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
