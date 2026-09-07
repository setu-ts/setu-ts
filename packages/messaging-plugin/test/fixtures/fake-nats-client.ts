/**
 * Fake NATS client for testing NatsBroker.
 *
 * Records all method calls and simulates NATS JetStream behavior.
 */
export interface FakeNatsOptions {
  /** Whether to reject on connect. */
  rejectConnect?: boolean;
  /** Pre-seeded messages for consume callbacks. */
  seededMessages?: Array<{
    subject: string;
    data: string;
    seq: number;
    /**
     * Delivery timestamp in epoch NANOSECONDS — the field a real nats 2.29
     * `ConsumerMsg.info` carries (`timestampNanos`), which the pre-M90d fake
     * mis-modeled as a `timestamp` string and so hid the Invalid Date defect.
     */
    timestampNanos: number;
    headers?: { keys(): Iterable<string>; get(key: string): string | undefined };
  }>;
  /** Whether streams.info should throw a generic error (not 'stream not found'). */
  rejectStreamInfo?: boolean;
  /**
   * Whether `jetstreamManager()` itself rejects — a server without JetStream
   * (X28-3). Real nats rejects the probe with a raw `503`.
   */
  rejectJetstreamManager?: boolean;
  /** Whether `streams.add` rejects (a restrictive stream policy, X28-3). */
  rejectStreamAdd?: boolean;
  /**
   * How `close()` fails, if at all.
   *
   * A failed startup releases the connection it opened, and that release must
   * never replace the startup error the caller is waiting on — neither by
   * throwing over it nor by surfacing as an unhandled rejection.
   */
  closeFailure?: 'throw' | 'reject';
  /**
   * Streams that already exist on the server. Defaults to `['MESSAGING']` —
   * the common real-world shape X28-2 records: every working NATS
   * installation declares its stream out of band, so the default models a
   * working server. Pass `existingStreams: []` to model a fresh server where
   * the broker's stream-creation path runs.
   */
  existingStreams?: readonly string[];
}

/**
 * Fake JetStream message.
 */
export class FakeNatsMessage {
  #data: Uint8Array;
  #seq: number;
  #timestampNanos: number;
  #subject: string;
  #headers: unknown;
  #acked = false;
  #naked = false;

  constructor(
    data: string,
    seq: number,
    timestampNanos: number,
    subject: string,
    headers?: { keys(): Iterable<string>; get(key: string): string | undefined },
  ) {
    this.#data = new TextEncoder().encode(data);
    this.#seq = seq;
    this.#timestampNanos = timestampNanos;
    this.#subject = subject;
    this.#headers = headers;
  }

  get data(): Uint8Array {
    return this.#data;
  }

  get seq(): number {
    return this.#seq;
  }

  get subject(): string {
    return this.#subject;
  }

  /** Matches the real `ConsumerMsg.info`: `timestampNanos`, not `timestamp`. */
  get info(): { timestampNanos: number } {
    return { timestampNanos: this.#timestampNanos };
  }

  get headers(): unknown {
    return this.#headers;
  }

  ack(): void {
    this.#acked = true;
  }

  nak(): void {
    this.#naked = true;
  }

  /** Whether the message was acknowledged. */
  isAcked(): boolean {
    return this.#acked;
  }

  /** Whether the message was nacked. */
  isNaked(): boolean {
    return this.#naked;
  }
}

/**
 * Fake NATS JetStream consumer.
 */
export class FakeNatsConsumer {
  #messages: FakeNatsMessage[];
  #filterSubject: string | undefined;
  #stopped = false;
  #failStop = false;

  constructor(messages: FakeNatsMessage[], filterSubject?: string) {
    this.#messages = messages;
    this.#filterSubject = filterSubject;
  }

  /**
   * Corrected (M90d review): the real `Consumer.consume` is
   * `(opts?) => Promise<ConsumerMessages>`, and this fake returned the handle
   * SYNCHRONOUSLY. That is what hid the broker storing an un-awaited promise
   * as its subscription, so `unsubscribe()` called `stop()` on a `Promise` and
   * the consumer stayed active. The real `Consumer` also has NO `stop()` —
   * `stop()` is a `ConsumerMessages` member — so this fake no longer offers
   * one either, and a caller stopping the wrong object fails loudly.
   */
  consume(
    options: { callback: (msg: FakeNatsMessage) => void },
  ): Promise<{ stop(): void }> {
    // Deliver messages using the callback from options, filtered by subject if filterSubject is set
    for (const msg of this.#messages) {
      if (!this.#stopped) {
        // If filterSubject is set, only deliver messages matching the filter
        if (this.#filterSubject === undefined || msg.subject === this.#filterSubject) {
          options.callback(msg);
        }
      }
    }
    return Promise.resolve({
      stop: (): void => {
        if (this.#failStop) {
          throw new Error('stop refused');
        }
        this.#stopped = true;
      },
    });
  }

  /** Whether a `stop()` on the handle this consumer produced has run. */
  isStopped(): boolean {
    return this.#stopped;
  }

  /**
   * Makes the next `stop()` on this consumer's handle throw.
   *
   * Shutdown stops each consumer in turn and swallows individual failures;
   * this is what lets a test prove one refusal does not strand the rest.
   */
  failNextStop(): void {
    this.#failStop = true;
  }
}

/**
 * Fake NATS JetStream manager.
 */
export class FakeNatsJetStreamManager {
  #streams: Set<string>;
  #consumers: Map<string, Set<string>>; // stream -> consumer names
  #calls: Array<{ method: string; args: unknown[] }>;
  #rejectStreamInfo: boolean;
  #rejectStreamAdd: boolean;

  constructor(
    options: {
      rejectStreamInfo?: boolean;
      rejectStreamAdd?: boolean;
      existingStreams?: readonly string[];
    } = {},
  ) {
    // Default `MESSAGING`: the working-server shape X28-2 records — every
    // working NATS installation declares its stream out of band.
    this.#streams = new Set(options.existingStreams ?? ['MESSAGING']);
    this.#consumers = new Map();
    this.#calls = [];
    this.#rejectStreamInfo = options.rejectStreamInfo ?? false;
    this.#rejectStreamAdd = options.rejectStreamAdd ?? false;
  }

  #record(method: string, args: unknown[]): void {
    this.#calls.push({ method, args: [...args] });
  }

  /** All recorded method calls. */
  get calls(): Array<{ method: string; args: unknown[] }> {
    return [...this.#calls];
  }

  streams = {
    info: (name: string): Promise<{ name: string }> => {
      this.#record('streams.info', [name]);
      if (this.#rejectStreamInfo) {
        const err = new Error(`generic error: ${name}`) as Error & { code?: string };
        err.code = 'generic_error';
        return Promise.reject(err);
      }
      if (this.#streams.has(name)) {
        return Promise.resolve({ name });
      }
      const err = new Error(`stream not found: ${name}`) as Error & { code?: string };
      err.code = 'stream_not_found';
      return Promise.reject(err);
    },
    add: (config: { name: string; subjects: string[] }): Promise<{ name: string }> => {
      this.#record('streams.add', [config]);
      // Corrected (X28-2): reject what the REAL server refuses. The broker
      // used to send `subjects: ['>']` — a catch-all that NATS answers with
      // exactly this sentence unless the stream carries `no_ack`, and a fake
      // that accepted any config is why the defect shipped and stayed.
      if (config.subjects?.includes('>') && (config as { no_ack?: boolean }).no_ack !== true) {
        return Promise.reject(new Error('capturing all subjects requires no-ack to be true'));
      }
      if (this.#rejectStreamAdd) {
        return Promise.reject(new Error('stream create refused by server policy'));
      }
      this.#streams.add(config.name);
      this.#consumers.set(config.name, new Set());
      return Promise.resolve({ name: config.name });
    },
  };

  consumers = {
    add: (stream: string, config: unknown): Promise<{ name: string }> => {
      this.#record('consumers.add', [stream, config]);
      // The broker creates consumers on the MANAGER and reads them back off
      // the JetStream CLIENT, which resolves `filter_subject` from the shared
      // record. Recording only locally left that lookup empty, so the fake
      // delivered EVERY seeded subject and the subject-filtering assertions
      // passed without exercising a filter at all.
      sharedConsumers.calls.push({ method: 'consumers.add', args: [stream, config] });
      const cfg = config as { name: string };
      if (!this.#consumers.has(stream)) {
        this.#consumers.set(stream, new Set());
      }
      this.#consumers.get(stream)!.add(cfg.name);
      return Promise.resolve({ name: cfg.name });
    },
    get: (stream: string, consumer: string): Promise<FakeNatsConsumer> => {
      this.#record('consumers.get', [stream, consumer]);
      // Look up the consumer's filter_subject from the recorded add calls
      const addCall = this.calls
        .filter((c) => c.method === 'consumers.add')
        .find((c) => (c.args[1] as { name: string })?.name === consumer);
      const filterSubject = addCall
        ? (addCall.args[1] as { filter_subject?: string }).filter_subject
        : undefined;
      return Promise.resolve(new FakeNatsConsumer([], filterSubject));
    },
  };
}

// Shared consumers object for JetStream to use
const sharedConsumers = {
  calls: [] as Array<{ method: string; args: unknown[] }>,
  add: (stream: string, config: unknown): Promise<{ name: string }> => {
    sharedConsumers.calls.push({ method: 'consumers.add', args: [stream, config] });
    return Promise.resolve({ name: (config as { name: string }).name });
  },
  get: (stream: string, consumer: string): Promise<FakeNatsConsumer> => {
    sharedConsumers.calls.push({ method: 'consumers.get', args: [stream, consumer] });
    return Promise.resolve(new FakeNatsConsumer([]));
  },
};

/**
 * Fake NATS JetStream.
 */
export class FakeNatsJetStream {
  #calls: Array<{ method: string; args: unknown[] }>;
  #seededMessages: Map<string, FakeNatsMessage[]>; // subject -> messages
  #handedOut: FakeNatsConsumer[] = [];

  constructor(
    seedMessages: Array<{
      subject: string;
      data: string;
      seq: number;
      timestampNanos: number;
      headers?: { keys(): Iterable<string>; get(key: string): string | undefined };
    }>,
  ) {
    this.#calls = [];
    this.#seededMessages = new Map();
    for (const msg of seedMessages) {
      if (!this.#seededMessages.has(msg.subject)) {
        this.#seededMessages.set(msg.subject, []);
      }
      this.#seededMessages.get(msg.subject)!.push(
        new FakeNatsMessage(msg.data, msg.seq, msg.timestampNanos, msg.subject, msg.headers),
      );
    }
  }

  #record(method: string, args: unknown[]): void {
    this.#calls.push({ method, args: [...args] });
  }

  /** All recorded method calls. */
  get calls(): Array<{ method: string; args: unknown[] }> {
    return [...this.#calls];
  }

  /**
   * All seeded message instances (the same objects delivered to consumers), so
   * tests can assert their ack/nak state after delivery.
   */
  get deliveredMessages(): FakeNatsMessage[] {
    return [...this.#seededMessages.values()].flat();
  }

  /**
   * Every consumer this JetStream handed to `consumers.get`, in call order.
   *
   * `consumers.get` constructs a fresh consumer per call, so without this a
   * test could not reach the object whose `consume()` handle the broker
   * stored — and could not tell a real `stop()` from the swallowed
   * `TypeError` that stopping the wrong object produces.
   */
  get handedOutConsumers(): readonly FakeNatsConsumer[] {
    return [...this.#handedOut];
  }

  publish(subject: string, data: Uint8Array, options?: unknown): void {
    this.#record('publish', options === undefined ? [subject, data] : [subject, data, options]);
  }

  consumers: {
    add(stream: string, config: unknown): Promise<{ name: string }>;
    get(stream: string, consumer: string): Promise<FakeNatsConsumer>;
  } = {
    add: (stream: string, config: unknown): Promise<{ name: string }> => {
      this.#record('consumers.add', [stream, config]);
      // Also record to shared for JetStreamManager compatibility
      sharedConsumers.calls.push({ method: 'consumers.add', args: [stream, config] });
      const cfg = config as { name: string };
      return Promise.resolve({ name: cfg.name });
    },
    get: (stream: string, consumer: string): Promise<FakeNatsConsumer> => {
      this.#record('consumers.get', [stream, consumer]);
      // Also record to shared for JetStreamManager compatibility
      sharedConsumers.calls.push({ method: 'consumers.get', args: [stream, consumer] });
      // Look up the consumer's filter_subject from the recorded add calls
      // `sharedConsumers.calls` is module-global and never reset, so an
      // explicit queue name reused by an earlier test could otherwise win.
      // The most recent add is the live one.
      const addCall = [...this.calls, ...sharedConsumers.calls]
        .filter((c) => c.method === 'consumers.add')
        .findLast((c) => (c.args[1] as { name: string })?.name === consumer);
      const filterSubject = addCall
        ? (addCall.args[1] as { filter_subject?: string }).filter_subject
        : undefined;
      // Return consumer with seeded messages, filtered by subject if filterSubject is set
      const messages: FakeNatsMessage[] = [];
      for (const [subject, msgs] of this.#seededMessages.entries()) {
        if (filterSubject === undefined || subject === filterSubject) {
          messages.push(...msgs);
        }
      }
      const handed = new FakeNatsConsumer(messages, filterSubject);
      this.#handedOut.push(handed);
      return Promise.resolve(handed);
    },
  };
}

/**
 * Fake NATS connection for testing.
 */
export class FakeNatsConnection {
  #options: FakeNatsOptions;
  #js: FakeNatsJetStream | null = null;
  #jsm: FakeNatsJetStreamManager | null = null;
  #closed = false;

  constructor(options: FakeNatsOptions = {}) {
    this.#options = options;
  }

  jetstreamManager(): Promise<FakeNatsJetStreamManager> {
    if (this.#closed) {
      return Promise.reject(new Error('Connection closed'));
    }
    // X28-3: a server without JetStream rejects the manager probe itself —
    // the broker must name that (`JetStreamUnavailableError`) rather than
    // leak the raw rejection.
    if (this.#options.rejectJetstreamManager) {
      return Promise.reject(new Error('503'));
    }
    if (!this.#jsm) {
      // exactOptionalPropertyTypes: omit each member rather than assign undefined.
      this.#jsm = new FakeNatsJetStreamManager({
        ...(this.#options.rejectStreamInfo !== undefined
          ? { rejectStreamInfo: this.#options.rejectStreamInfo }
          : {}),
        ...(this.#options.rejectStreamAdd !== undefined
          ? { rejectStreamAdd: this.#options.rejectStreamAdd }
          : {}),
        ...(this.#options.existingStreams !== undefined
          ? { existingStreams: this.#options.existingStreams }
          : {}),
      });
    }
    return Promise.resolve(this.#jsm);
  }

  jetstream(): FakeNatsJetStream {
    if (this.#closed) {
      throw new Error('Connection closed');
    }
    if (!this.#js) {
      this.#js = new FakeNatsJetStream(this.#options.seededMessages ?? []);
    }
    return this.#js;
  }

  /**
   * Closes the connection.
   *
   * Returns a promise because the real `NatsConnection.close()` is
   * `(): Promise<void>` — read off the shipped nats 2.29.3 `core.d.ts`. The
   * flag is set synchronously, so {@linkcode FakeNatsConnection.isClosed} is
   * true the moment this returns, as with the real client's `isClosed()`.
   */
  close(): Promise<void> {
    this.#closed = true;
    this.#js = null;
    this.#jsm = null;
    if (this.#options.closeFailure === 'throw') {
      throw new Error('close failed synchronously');
    }
    if (this.#options.closeFailure === 'reject') {
      return Promise.reject(new Error('close failed asynchronously'));
    }
    return Promise.resolve();
  }

  /**
   * Whether {@linkcode FakeNatsConnection.close} has run.
   *
   * The real nats connection exposes `isClosed()`, so this is the faithful
   * shape rather than a test-only affordance; it is what lets a failed
   * `connect()` be checked for the released socket.
   */
  isClosed(): boolean {
    return this.#closed;
  }
}
