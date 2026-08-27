import { createCachedProbe } from '@setu-ts/common';
import type {
  ISubscription,
  MessageHandler,
  MessageMetadata,
  RequestHandler,
  RequestOptions,
  SubscribeOptions,
} from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';
import type { ISerializer } from '../serializers/serializer.ts';
import type { MessageBrokerAdapter } from './message-broker.ts';
import { createTopicInbox } from './inbox.ts';
import { RequestReplyCore } from './request-reply-core.ts';
import { ReconnectSupervisor } from './reconnect.ts';
import type { INatsConnection, INatsHeaders, NatsOptions } from '../interfaces/index.ts';

/**
 * Lazily load nats at runtime.
 *
 * @returns The nats module
 * @throws {Error} If the npm:nats package cannot be resolved
 */
async function loadNats(): Promise<typeof import('npm:nats@2.x')> {
  const mod = await import('npm:nats@2.x');
  return mod;
}

/**
 * Structural validation for NATS connection.
 *
 * @param client - The object to validate
 * @returns `true` if structural checks pass
 */
export function validateClient(client: unknown): client is INatsConnection {
  if (client === null || typeof client !== 'object') {
    return false;
  }
  const required = ['jetstream', 'jetstreamManager', 'close'];
  for (const method of required) {
    if (typeof (client as Record<string, unknown>)[method] !== 'function') {
      return false;
    }
  }
  return true;
}

/**
 * The connection plus the header factory that came with it.
 *
 * A lazily-loaded nats module carries `headers()`, so a real connection can
 * always build `MsgHdrs`. An injected connection carries no module, so the
 * factory is absent unless the application supplied one through
 * {@linkcode NatsOptions.headersFactory}.
 */
interface ResolvedNatsClient {
  readonly connection: INatsConnection;
  readonly headersFactory?: () => INatsHeaders;
}

/**
 * Resolve the NATS connection: prefer injected client, then lazy-load nats.
 *
 * This is the single connect path. An earlier revision branched in `connect()`
 * and left this function's lazy arm unreachable — the same logic in two places,
 * one of them dead.
 *
 * @param url - NATS connection URL(s)
 * @param injectedClient - Optionally injected NATS connection
 * @returns The resolved connection and, for a lazily-loaded module, its header factory
 * @throws {Error} If no client injected and nats cannot be loaded
 */
async function resolveClient(
  url: string,
  injectedClient?: INatsConnection,
): Promise<ResolvedNatsClient> {
  if (injectedClient !== undefined) {
    if (!validateClient(injectedClient)) {
      throw new Error(
        'Injected NATS client does not match the required structural shape ' +
          '(needs: jetstream, jetstreamManager, close)',
      );
    }
    return { connection: injectedClient };
  }
  const nats = await loadNats();
  const connection = await nats.connect({ servers: url });
  return {
    connection: connection as unknown as INatsConnection,
    headersFactory: () => nats.headers() as unknown as INatsHeaders,
  };
}

/**
 * Internal consumer entry.
 */
interface ActiveConsumer {
  id: string;
  consumer: unknown;
  subscription: unknown;
}

/**
 * NATS JetStream message broker implementation.
 *
 * @since 0.1.0
 */
export class NatsBroker implements MessageBrokerAdapter {
  #runtime: IRuntimeServices;
  #serializer: ISerializer;
  #url: string;
  #injectedClient: INatsConnection | undefined;
  #streamName: string;
  #headersFactory: (() => INatsHeaders) | undefined;
  #logger: { error: (msg: string) => void } | undefined;
  /** Guards the no-header-channel report so it is emitted once, not per publish. */
  #headerWarningEmitted = false;
  #connection: INatsConnection | null = null;
  #js: unknown | null = null;
  #ready = false;
  #activeConsumers: Map<string, ActiveConsumer>;
  #rr: RequestReplyCore;
  #supervisor: ReconnectSupervisor;
  #probe: () => Promise<boolean>;

  /**
   * Creates a new NATS broker.
   *
   * @param runtime - Runtime services for uuid, timestamps, and timers
   * @param serializer - Serializer for message payloads
   * @param options - NATS connection and configuration options
   */
  constructor(
    runtime: IRuntimeServices,
    serializer: ISerializer,
    options?: NatsOptions,
  ) {
    this.#runtime = runtime;
    this.#serializer = serializer;
    this.#url = options?.url ?? 'nats://localhost:4222';
    this.#injectedClient = options?.client;
    this.#streamName = options?.streamName ?? 'MESSAGING';
    this.#headersFactory = options?.headersFactory;
    this.#logger = options?.logger;
    this.#activeConsumers = new Map();
    this.#rr = new RequestReplyCore({
      publish: (topic, message, headers) => this.publishWithHeaders(topic, message, headers ?? {}),
      subscribe: (topic, handler, options) => this.subscribe(topic, handler, options),
      uuid: () => this.#runtime.uuid(),
      setTimeout: (fn, ms) => this.#runtime.setTimeout(fn, ms),
      clearTimeout: (handle) => this.#runtime.clearTimeout(handle),
      openInbox: createTopicInbox({
        subscribe: (topic, handler, options) => this.subscribe(topic, handler, options),
        uuid: () => this.#runtime.uuid(),
      }),
    });
    this.#supervisor = new ReconnectSupervisor({
      runtime,
      mode: 'observe',
      attachFaultListener: (onFault) => this.#attachEvent('Disconnect', onFault),
      attachRecoveryListener: (onRecovered) => this.#attachEvent('Reconnect', onRecovered),
    });
    // Built once so the TTL cache and coalescing persist across health
    // scrapes (M70c §3.3). The inner probe performs only the I/O half of the
    // check (isClosed + rtt); the zero-cost fault-flag check is done fresh in
    // reachability() so an observed Disconnect is never hidden by the cache.
    this.#probe = createCachedProbe({
      probe: async () => {
        const connection = this.#connection;
        if (connection === null) {
          return false;
        }
        if (typeof connection.isClosed !== 'function' || typeof connection.rtt !== 'function') {
          return false;
        }
        const isClosed = connection.isClosed;
        const rtt = connection.rtt;
        if (isClosed.call(connection) === false) {
          await rtt.call(connection);
          return true;
        }
        return false;
      },
      hrtime: () => this.#runtime.hrtime(),
      setTimer: (fn, ms) => this.#runtime.setTimeout(fn, ms),
      clearTimer: (handle) => this.#runtime.clearTimeout(handle),
    });
  }

  /**
   * Connects to NATS and ensures JetStream stream exists.
   *
   * @returns Resolves when connected
   * @since 0.1.0
   */
  async connect(): Promise<void> {
    if (this.#ready) {
      return;
    }
    const resolved = await resolveClient(this.#url, this.#injectedClient);
    this.#connection = resolved.connection;
    // An explicitly supplied factory wins; the module's own is the fallback.
    this.#headersFactory ??= resolved.headersFactory;

    // Ensure stream exists (unconditional for both injected and real connections)
    const realConn = this.#connection as unknown as { jetstreamManager(): Promise<unknown> };
    const jsm = await realConn.jetstreamManager();
    try {
      const jsmTyped = jsm as unknown as {
        streams: {
          info(name: string): Promise<unknown>;
          add(config: { name: string; subjects: string[] }): Promise<unknown>;
        };
      };
      await jsmTyped.streams.info(this.#streamName);
    } catch (err) {
      const e = err as Error;
      if (e.message.includes('stream not found')) {
        const jsmTyped = jsm as unknown as {
          streams: {
            add(config: { name: string; subjects: string[] }): Promise<unknown>;
          };
        };
        await jsmTyped.streams.add({
          name: this.#streamName,
          subjects: ['>'],
        });
      } else {
        throw e;
      }
    }

    // Get JetStream instance unconditionally
    const realConn2 = this.#connection as unknown as { jetstream(): unknown };
    this.#js = realConn2.jetstream();
    this.#ready = true;
    this.#supervisor.start();
  }

  /**
   * Disconnects from NATS.
   *
   * @returns Resolves when disconnected
   * @since 0.1.0
   */
  async disconnect(): Promise<void> {
    this.#supervisor.stop();
    await this.#rr.close();
    // Stop all active consumers
    for (const consumer of this.#activeConsumers.values()) {
      try {
        const realConsumer = consumer.consumer as unknown as { stop(): void };
        realConsumer.stop();
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.#activeConsumers.clear();
    if (this.#connection) {
      const realConn = this.#connection as unknown as { close(): void };
      realConn.close();
    }
    this.#connection = null;
    this.#js = null;
    this.#ready = false;
  }

  /**
   * Checks if the broker is connected.
   *
   * @returns `true` if connected, `false` otherwise
   * @since 0.1.0
   */
  isReady(): boolean {
    return this.#ready;
  }

  /**
   * Tri-state backend reachability (M70c).
   *
   * nats reconnects itself, so the broker runs the supervisor in **observe**
   * mode: `Disconnect`/`Reconnect` events mark the fault window, and the
   * probe is `isClosed() === false` **and** `rtt()` resolving. `true` when
   * both hold, `false` when the window is active or the connection reports
   * closed, `undefined` when the injected client exposes neither member (a
   * minimal fake) — the indicator then reports `reachable: 'unknown'`.
   *
   * @returns `true`/`false`/`undefined` as described
   * @since 0.1.0
   */
  async reachability(): Promise<boolean | undefined> {
    const connection = this.#connection;
    if (connection === null) {
      return undefined;
    }
    if (typeof connection.isClosed !== 'function' || typeof connection.rtt !== 'function') {
      return undefined;
    }
    // The observed fault window is a zero-cost, always-current signal; check
    // it fresh (uncached) so a Disconnect is reported immediately and a
    // Reconnect clears it without waiting for the I/O probe's TTL.
    if (this.#supervisor.faulted) {
      return false;
    }
    return await this.#probe();
  }

  /**
   * Boolean port member (M70c): `false` only when positively unreachable.
   *
   * @returns `true` when reachable or unprobeable, `false` when the fault
   *   window is active or the connection is closed
   * @since 0.1.0
   */
  async isHealthy(): Promise<boolean> {
    const reachable = await this.reachability();
    return reachable !== false;
  }

  /**
   * Attaches a connection event listener and returns a disposer that removes
   * it. A client without an event surface (a minimal injected fake) returns a
   * no-op disposer.
   */
  #attachEvent(event: string, onEvent: () => void): () => void {
    const connection = this.#connection;
    if (connection === null || typeof connection.on !== 'function') {
      return () => {};
    }
    const listener = (...args: unknown[]): void => {
      void args;
      onEvent();
    };
    connection.on(event, listener);
    return (): void => {
      if (typeof connection.off === 'function') {
        connection.off(event, listener);
      }
    };
  }

  /**
   * Publishes a message to a subject (topic).
   *
   * @typeParam T - The message payload type
   * @param topic - The subject to publish to
   * @param message - The message payload
   * @returns Resolves when published
   * @since 0.1.0
   */
  publish<T>(topic: string, message: T): Promise<void> {
    return this.publishWithHeaders(topic, message, {});
  }

  /** Publishes a message with framework-owned transport headers. @internal */
  publishWithHeaders<T>(
    topic: string,
    message: T,
    headers: Readonly<Record<string, string>>,
  ): Promise<void> {
    if (!this.#connection) {
      return Promise.reject(new Error('NatsBroker is not connected'));
    }
    const serialized = this.#serializer.serialize(message);
    const encoder = new TextEncoder();
    const data = encoder.encode(serialized);

    const realJs = this.#js as unknown as {
      publish(subject: string, data: Uint8Array, options?: { headers: INatsHeaders }): void;
    };
    const natsHeaders = this.#headersFactory?.();
    if (natsHeaders) {
      for (const [key, value] of Object.entries(headers)) natsHeaders.set(key, value);
      realJs.publish(topic, data, { headers: natsHeaders });
    } else {
      // No `MsgHdrs` factory: an injected connection carries no nats module, so
      // there is nothing to build headers with. Publishing still succeeds, but
      // trace context cannot cross this broker — report it once rather than
      // dropping the header silently on every publish.
      this.#reportMissingHeaderChannel(headers);
      realJs.publish(topic, data);
    }
    return Promise.resolve();
  }

  /**
   * Subscribes to a topic using JetStream durable consumers.
   *
   * @typeParam T - The message payload type
   * @param topic - The subject to subscribe to
   * @param handler - The handler to invoke for each message
   * @param options - Optional subscription options (queue for durable consumer name)
   * @returns The subscription handle
   * @since 0.1.0
   */
  async subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    if (!this.#connection) {
      throw new Error('NatsBroker is not connected');
    }

    const subscriptionId = this.#runtime.uuid();
    const consumerName = options?.queue ?? `messaging-${this.#runtime.uuid()}`;

    const realJs = this.#js!;

    const realJsTyped = realJs as unknown as {
      consumers: {
        add(stream: string, config: unknown): Promise<unknown>;
        get(stream: string, consumer: string): Promise<unknown>;
      };
    };

    // Ensure durable consumer exists
    try {
      await realJsTyped.consumers.add(this.#streamName, {
        name: consumerName,
        filter_subject: topic,
        durable_name: consumerName,
        ack_policy: 'explicit',
      });
    } catch (err) {
      const e = err as Error;
      // Consumer may already exist - that's fine
      if (
        !e.message.includes('consumer name already exists') &&
        !e.message.includes('duplicate')
      ) {
        throw e;
      }
    }

    // Get consumer and start consuming
    const consumer = await realJsTyped.consumers.get(this.#streamName, consumerName);
    const consumerTyped = consumer as unknown as {
      consume(options: { callback: (msg: unknown) => void }): unknown;
    };

    const subscription = consumerTyped.consume({
      callback: (msg) => {
        const msgTyped = msg as unknown as {
          data: Uint8Array;
          seq: number;
          info: { timestamp: string };
          headers: unknown;
          ack(): void;
          nak(): void;
        };

        const content = new TextDecoder().decode(msgTyped.data);
        const deserialized = this.#serializer.deserialize<T>(content);

        const metadata: MessageMetadata = {
          topic,
          messageId: String(msgTyped.seq),
          timestamp: new Date(msgTyped.info.timestamp),
          headers: toHeaderRecord(msgTyped.headers),
        };

        const handlerResult = handler(deserialized, metadata);
        if (handlerResult instanceof Promise) {
          handlerResult.then(() => {
            msgTyped.ack();
          }).catch(() => {
            msgTyped.nak();
          });
        } else {
          msgTyped.ack();
        }
      },
    });

    const activeConsumer: ActiveConsumer = {
      id: subscriptionId,
      consumer,
      subscription,
    };
    this.#activeConsumers.set(subscriptionId, activeConsumer);

    return {
      unsubscribe: (): Promise<void> => {
        const consumer = this.#activeConsumers.get(subscriptionId);
        if (consumer) {
          try {
            const realSub = consumer.subscription as unknown as { stop(): void };
            realSub.stop();
          } catch {
            // Ignore errors
          }
          this.#activeConsumers.delete(subscriptionId);
        }
        return Promise.resolve();
      },
    };
  }

  /** Subscribes through the header-aware internal path. @internal */
  subscribeWithHeaders<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    return this.subscribe(topic, handler, options);
  }

  /**
   * Sends a request and awaits a single correlated reply.
   *
   * @typeParam TReq - The request payload type
   * @typeParam TRes - The reply payload type
   * @param topic - Destination topic a responder is listening on
   * @param message - The request payload
   * @param options - Reply timeout behavior
   * @returns The reply payload
   * @since 0.1.0
   */
  request<TReq, TRes>(topic: string, message: TReq, options?: RequestOptions): Promise<TRes> {
    return this.requestWithHeaders(topic, message, {}, options);
  }

  /** Sends request-reply traffic with framework-owned headers. @internal */
  requestWithHeaders<TReq, TRes>(
    topic: string,
    message: TReq,
    headers: Readonly<Record<string, string>>,
    options?: RequestOptions,
  ): Promise<TRes> {
    return this.#rr.request<TRes>(topic, message, options, headers);
  }

  /**
   * Registers a responder whose result is returned to the requesting caller.
   *
   * @typeParam TReq - The request payload type
   * @typeParam TRes - The reply payload type
   * @param topic - The request topic to respond on
   * @param handler - Invoked per request; its result is returned to the caller
   * @param options - Consumer group behavior
   * @returns The active subscription
   * @since 0.1.0
   */
  respond<TReq, TRes>(
    topic: string,
    handler: RequestHandler<TReq, TRes>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    return this.#rr.respond(
      topic,
      (message, metadata) => handler(message as TReq, metadata),
      options,
    );
  }
  /**
   * Reports, at most once, that headers were dropped for want of a `MsgHdrs`
   * factory. Silent when the caller supplied no headers, since nothing is lost.
   *
   * @param headers - The headers that could not be attached
   */
  #reportMissingHeaderChannel(headers: Readonly<Record<string, string>>): void {
    if (this.#headerWarningEmitted || Object.keys(headers).length === 0) {
      return;
    }
    this.#headerWarningEmitted = true;
    this.#logger?.error(
      'NatsBroker: transport headers dropped because no NATS headers factory is available. ' +
        'Pass NatsOptions.headersFactory (for example `() => nats.headers()`) alongside an ' +
        'injected client so trace context can cross the broker.',
    );
  }
}

function toHeaderRecord(headers: unknown): Readonly<Record<string, string>> {
  if (!headers || typeof headers !== 'object') return {};
  const candidate = headers as { keys?: unknown; get?: unknown };
  if (typeof candidate.keys !== 'function' || typeof candidate.get !== 'function') return {};
  const values: Record<string, string> = {};
  for (const key of candidate.keys() as Iterable<string>) {
    const value = (candidate.get as (name: string) => unknown)(key);
    if (typeof value === 'string') values[key] = value;
  }
  return values;
}
