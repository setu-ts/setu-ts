/**
 * Test doubles for the Durable Object surface.
 *
 * Two platform behaviours are reproduced rather than approximated, because
 * getting either wrong would make a real defect pass:
 *
 * 1. **A Workers upgrade response carries a `webSocket` member.** A standard
 *    `Response` silently DISCARDS it — `packages/runtime`'s upgrader documents
 *    the same trap — so `FakeDurableObjectNamespace` answers a plain object
 *    shaped like the Workers response instead of round-tripping through
 *    `new Response()`. A fake that used a real `Response` would make
 *    `asUpgradeResponse` throw on every happy path.
 * 2. **The Durable Object side is driven by the runtime, not by the client.**
 *    A client `send` does not reach the DO by itself; the platform invokes
 *    `webSocketMessage(server, message)` on the class. The fake routes it the
 *    same way, so the DO-side fan-out is genuinely exercised rather than
 *    simulated by the test.
 *
 * `FakeDurableObjectState.getWebSockets()` is also the only membership the
 * fakes expose — matching the platform, and ensuring a core that started
 * caching membership in a field would fail the hibernation tests.
 */

import type { IServiceBinding } from '../src/bindings/facades.ts';
import type {
  DurableObjectMessageEvent,
  IDurableObjectClientSocket,
  IDurableObjectState,
  IDurableObjectStorage,
  IDurableObjectWebSocket,
} from '../src/durable-objects/do-facades.ts';
import type { DurableObjectWebSocketPair } from '../src/durable-objects/do-websocket-host.ts';
import { DistributedLockObjectCore } from '../src/durable-objects/distributed-lock-object.ts';
import { RealtimeBackplaneObjectCore } from '../src/durable-objects/realtime-backplane-object.ts';
import type { IDurableObjectNamespace } from '../src/bindings/facades.ts';

/** In-memory Durable Object storage. */
export class FakeDurableObjectStorage implements IDurableObjectStorage {
  readonly entries = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.entries.get(key) as T | undefined);
  }

  put<T>(key: string, value: T): Promise<void> {
    this.entries.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(key));
  }
}

/**
 * A Durable Object `ctx`.
 *
 * `getWebSockets()` returns a copy, as the platform does, so a caller cannot
 * mutate membership by holding the array.
 */
export class FakeDurableObjectState implements IDurableObjectState {
  readonly accepted: IDurableObjectWebSocket[] = [];
  readonly storage: FakeDurableObjectStorage;

  constructor(storage: FakeDurableObjectStorage = new FakeDurableObjectStorage()) {
    this.storage = storage;
  }

  acceptWebSocket(ws: IDurableObjectWebSocket): void {
    this.accepted.push(ws);
  }

  getWebSockets(): IDurableObjectWebSocket[] {
    return [...this.accepted];
  }

  /** The runtime drops a closed socket from membership; the fake does too. */
  drop(ws: IDurableObjectWebSocket): void {
    const index = this.accepted.indexOf(ws);
    if (index >= 0) this.accepted.splice(index, 1);
  }
}

/** The server half — what the Durable Object holds and sends through. */
export class FakeServerSocket implements IDurableObjectWebSocket {
  peer: FakeClientSocket | undefined;
  closed = false;
  closeCode: number | undefined;
  /** Set to make `send` throw, reproducing a peer that is already gone. */
  failSend = false;
  readonly sent: (string | ArrayBuffer)[] = [];

  send(message: string | ArrayBuffer): void {
    if (this.failSend) throw new Error('server socket write failed');
    this.sent.push(message);
    this.peer?.receive(message);
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.peer?.fire('close', { data: reason ?? '' });
  }
}

/** The client half — what a replica accepts and listens on. */
export class FakeClientSocket implements IDurableObjectClientSocket {
  accepted = false;
  closed = false;
  closeCode: number | undefined;
  /** Set to make `send` throw, reproducing a dead connection. */
  failSend = false;
  readonly sent: (string | ArrayBuffer)[] = [];
  /** Routes a client send into the Durable Object, as the platform does. */
  onSend: ((message: string | ArrayBuffer) => void) | undefined;
  /** Invoked when the replica closes, so the fake state can drop the peer. */
  onClose: (() => void) | undefined;

  readonly #listeners = new Map<string, ((event: DurableObjectMessageEvent) => void)[]>();

  accept(): void {
    this.accepted = true;
  }

  send(message: string | ArrayBuffer): void {
    if (this.failSend) throw new Error('client socket write failed');
    this.sent.push(message);
    this.onSend?.(message);
  }

  close(code?: number, _reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.onClose?.();
  }

  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: (event: DurableObjectMessageEvent) => void,
  ): void {
    const existing = this.#listeners.get(type);
    if (existing === undefined) {
      this.#listeners.set(type, [listener]);
      return;
    }
    existing.push(listener);
  }

  /** Delivers a frame from the Durable Object to this replica. */
  receive(message: string | ArrayBuffer): void {
    this.fire('message', { data: message });
  }

  /** Fires one event at every registered listener. */
  fire(type: 'message' | 'close' | 'error', event: DurableObjectMessageEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

/** Creates a linked pair whose halves deliver to each other. */
export function linkedPair(): { client: FakeClientSocket; server: FakeServerSocket } {
  const client = new FakeClientSocket();
  const server = new FakeServerSocket();
  server.peer = client;
  return { client, server };
}

/**
 * A namespace backed by REAL cores, one object per `idFromName` value.
 *
 * This is what makes the integration tests a read-it-back proof rather than an
 * assertion about calls: a frame published by one replica travels through the
 * genuine `RealtimeBackplaneObjectCore` fan-out before another replica sees it.
 */
export class FakeDurableObjectNamespace implements IDurableObjectNamespace {
  readonly states = new Map<string, FakeDurableObjectState>();
  readonly cores = new Map<string, RealtimeBackplaneObjectCore>();
  readonly lockCores = new Map<string, DistributedLockObjectCore>();
  /** Names every `idFromName` call received, so key derivation is assertable. */
  readonly requestedNames: string[] = [];
  /** Every replica-side socket handed out, so a test can break one. */
  readonly clients: FakeClientSocket[] = [];
  /** Set to answer upgrades with no `webSocket`, as a non-DO endpoint would. */
  omitSocket = false;
  /** Set to answer every lock call with this status instead of handling it. */
  lockStatus: number | undefined;
  /** Which core kind this namespace serves. */
  readonly kind: 'realtime' | 'lock';
  /** Clock handed to every lock core, so expiry is drivable. */
  now: () => number = () => 0;

  constructor(kind: 'realtime' | 'lock' = 'realtime') {
    this.kind = kind;
  }

  idFromName(name: string): unknown {
    this.requestedNames.push(name);
    return name;
  }

  get(id: unknown): IServiceBinding {
    const name = String(id);
    return {
      fetch: (input: Request | string, init?: RequestInit): Promise<Response> =>
        this.#fetch(name, input, init),
    };
  }

  /** The state for one object name, created on first use. */
  state(name: string): FakeDurableObjectState {
    let state = this.states.get(name);
    if (state === undefined) {
      state = new FakeDurableObjectState();
      this.states.set(name, state);
    }
    return state;
  }

  /**
   * Serializes calls per object, reproducing the platform's **input gate**.
   *
   * Cloudflare guarantees that "while a storage operation is executing, no
   * events shall be delivered to the object", which is what makes the lock's
   * read-compare-write atomic with no transaction. A fake that let calls
   * interleave would report five simultaneous winners for one lock — and would
   * be testing the fake's concurrency, not the platform's guarantee.
   */
  readonly #gates = new Map<string, Promise<unknown>>();

  #fetch(name: string, input: Request | string, init?: RequestInit): Promise<Response> {
    const previous = this.#gates.get(name) ?? Promise.resolve();
    const next = previous.then(() => this.#handle(name, input, init));
    // Swallow rejection on the CHAIN only, so one failed call cannot poison
    // every later call to the same object; the caller still sees `next`.
    this.#gates.set(name, next.catch(() => undefined));
    return next;
  }

  async #handle(name: string, input: Request | string, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input.url;
    const request = new Request(url, init);

    if (this.kind === 'lock') {
      if (this.lockStatus !== undefined) {
        return new Response('refused', { status: this.lockStatus });
      }
      let core = this.lockCores.get(name);
      if (core === undefined) {
        core = new DistributedLockObjectCore(this.state(name), { now: () => this.now() });
        this.lockCores.set(name, core);
      }
      return await core.fetch(request);
    }

    let pair: DurableObjectWebSocketPair | undefined;
    // A fresh core per upgrade over the SAME state. That is not a shortcut —
    // it is what the platform does when a hibernated object wakes: the
    // constructor re-runs and only `state` survives. Any membership the core
    // kept in a field would be lost here, and the fan-out tests would fail.
    const core = new RealtimeBackplaneObjectCore(this.state(name), {
      createPair: {
        createPair: (): DurableObjectWebSocketPair => {
          pair = this.#pair(name);
          return pair;
        },
      },
    });
    this.cores.set(name, core);

    const response = await core.fetch(request);
    if (response.status !== 101 || pair === undefined || this.omitSocket) {
      return response;
    }

    // A standard `Response` DISCARDS the Workers-only `webSocket` member, so
    // the fake answers the shape the platform actually produces. Reproducing
    // this is the whole point — a real `Response` here would make every happy
    // path throw in `asUpgradeResponse`.
    return { status: 101, webSocket: pair.client } as unknown as Response;
  }

  /** Builds a pair wired so a client send reaches the object's handler. */
  #pair(name: string): DurableObjectWebSocketPair {
    const { client, server } = linkedPair();
    this.clients.push(client);
    client.onSend = (message): void => {
      this.cores.get(name)?.webSocketMessage(server, message);
    };
    client.onClose = (): void => {
      this.states.get(name)?.drop(server);
    };
    return { client, server };
  }
}
