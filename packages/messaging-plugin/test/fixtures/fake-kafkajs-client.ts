/**
 * Fake Kafka client for testing KafkaBroker.
 *
 * Records all method calls and simulates Kafka behavior.
 */
/** A header value in any shape kafkajs's `IHeaders` admits. */
export type KafkaHeaderValue =
  | string
  | Uint8Array
  | readonly (string | Uint8Array)[]
  | undefined;

export interface FakeKafkaOptions {
  /** Pre-seeded messages for eachMessage callbacks. */
  seededMessages?: Array<{
    topic: string;
    value: string;
    partition: number;
    offset: string;
    timestamp: string;
    /**
     * Header values. A plain `string` is encoded to bytes, modelling how real
     * kafkajs delivers a header it was given as a string. A `Uint8Array` or an
     * array is passed through untouched, so a test can exercise the other arms
     * of kafkajs's `IHeaders` (`Buffer | string | (Buffer | string)[] |
     * undefined`) which a string-only fake cannot express.
     */
    headers: Record<string, KafkaHeaderValue>;
  }>;
  /** Whether stop() should reject. */
  rejectStop?: boolean;
}

/**
 * Fake Kafka message.
 *
 * Corrected (90d verification, Finding 1): this double used to carry a public
 * `partition` getter, but real kafkajs's `KafkaMessage` has NO `partition` —
 * the partition arrives on the OUTER `eachMessage` payload, not on the record.
 * The getter masked a real defect (the broker read `message.partition` and
 * produced `"undefined:<offset>"` message ids). The message now models the
 * real record shape; the partition travels with the consumer's delivery call
 * (the consumer's assignment is what knows it), never on the message.
 */
export class FakeKafkaMessage {
  #value: Uint8Array;
  #offset: string;
  #timestamp: string;
  #headers: Record<string, KafkaHeaderValue>;
  #key: Uint8Array | null;

  constructor(
    value: string,
    offset: string,
    timestamp: string,
    headers: Record<string, KafkaHeaderValue>,
    key: string | null = null,
  ) {
    this.#value = new TextEncoder().encode(value);
    this.#offset = offset;
    this.#timestamp = timestamp;
    this.#headers = Object.fromEntries(
      Object.entries(headers).map((
        [k, v],
      ) => [k, typeof v === 'string' ? new TextEncoder().encode(v) : v]),
    );
    this.#key = key !== null ? new TextEncoder().encode(key) : null;
  }

  get key(): Uint8Array | null {
    return this.#key;
  }

  get value(): Uint8Array {
    return this.#value;
  }

  get timestamp(): string {
    return this.#timestamp;
  }

  get headers(): Record<string, KafkaHeaderValue> {
    return { ...this.#headers };
  }

  get offset(): string {
    return this.#offset;
  }
}

/**
 * Fake Kafka consumer.
 */
export class FakeKafkaConsumer {
  #subscribedTopics: string[];
  #runOptions: {
    eachMessage: (
      data: { topic: string; partition: number; message: FakeKafkaMessage },
    ) => Promise<void>;
  } | null;
  #running: boolean;
  #calls: Array<{ method: string; args: unknown[] }>;
  #committedOffsets: string[];
  #rejectStop: boolean;
  #seededMessages: Array<{
    topic: string;
    value: string;
    partition: number;
    offset: string;
    timestamp: string;
    headers: Record<string, KafkaHeaderValue>;
  }>;

  constructor(
    _groupId: string,
    rejectStop: boolean = false,
    seededMessages?: Array<{
      topic: string;
      value: string;
      partition: number;
      offset: string;
      timestamp: string;
      headers: Record<string, KafkaHeaderValue>;
    }>,
  ) {
    this.#subscribedTopics = [];
    this.#runOptions = null;
    this.#running = false;
    this.#calls = [];
    this.#committedOffsets = [];
    this.#rejectStop = rejectStop;
    this.#seededMessages = seededMessages ?? [];
  }

  #record(method: string, args: unknown[]): void {
    this.#calls.push({ method, args: [...args] });
  }

  /** All recorded method calls. */
  get calls(): Array<{ method: string; args: unknown[] }> {
    return [...this.#calls];
  }

  /**
   * Offsets kafkajs would have auto-committed — i.e. those whose `eachMessage`
   * resolved. A message whose handler throws leaves `eachMessage` rejected and
   * its offset absent here (no commit → redelivery).
   */
  get committedOffsets(): string[] {
    return [...this.#committedOffsets];
  }

  /**
   * Runs one message through `eachMessage`, modelling kafkajs auto-commit:
   * commit the offset only when `eachMessage` resolves; on rejection, do not
   * commit (and swallow so there is no unhandled rejection).
   *
   * `partition` is the partition the record was fetched from — the OUTER
   * `eachMessage` argument, exactly as real kafkajs delivers it. It can never
   * come off the message record, which has no such member.
   */
  async #deliverAndTrack(
    topic: string,
    partition: number,
    message: FakeKafkaMessage,
  ): Promise<void> {
    if (!this.#runOptions) {
      return;
    }
    try {
      await this.#runOptions.eachMessage({ topic, partition, message });
      this.#committedOffsets.push(message.offset);
    } catch {
      // eachMessage rejected → kafkajs does NOT commit the offset (redelivery).
    }
  }

  connect(): Promise<void> {
    this.#record('connect', []);
    return Promise.resolve();
  }

  subscribe(options: { topic: string; fromBeginning?: boolean }): Promise<void> {
    this.#record('subscribe', [options]);
    this.#subscribedTopics.push(options.topic);
    return Promise.resolve();
  }

  run(
    options: {
      eachMessage: (
        data: { topic: string; partition: number; message: FakeKafkaMessage },
      ) => Promise<void>;
    },
  ): Promise<void> {
    this.#record('run', [options]);
    this.#runOptions = options;
    this.#running = true;
    // Auto-deliver seeded messages to the handler, tracking commit-on-resolve.
    // The seeded record's partition feeds the OUTER eachMessage payload, the
    // way a real consumer reports the partition it fetched from.
    for (const msg of this.#seededMessages) {
      if (this.#subscribedTopics.includes(msg.topic)) {
        void this.#deliverAndTrack(
          msg.topic,
          msg.partition,
          new FakeKafkaMessage(msg.value, msg.offset, msg.timestamp, msg.headers),
        );
      }
    }
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.#record('stop', []);
    this.#running = false;
    if (this.#rejectStop) {
      return Promise.reject(new Error('Stop rejected'));
    }
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.#record('disconnect', []);
    this.#running = false;
    return Promise.resolve();
  }

  /**
   * Deliver a seeded message to the eachMessage handler (tracks commit-on-
   * resolve). `partition` defaults to 0 and is delivered as the OUTER
   * `eachMessage` argument, not on the message.
   */
  async deliver(topic: string, message: FakeKafkaMessage, partition = 0): Promise<void> {
    if (this.#running && this.#runOptions) {
      await this.#deliverAndTrack(topic, partition, message);
    }
  }
}

/**
 * Fake Kafka producer.
 */
export class FakeKafkaProducer {
  #calls: Array<{ method: string; args: unknown[] }>;
  #route: ((topic: string, value: string) => Promise<void>) | null;
  #listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  /**
   * The `producer.events` map, keyed as real kafkajs keys it. The VALUES are
   * the only accepted listener names (X28-1).
   */
  readonly events = {
    CONNECT: 'producer.connect',
    DISCONNECT: 'producer.disconnect',
    REQUEST: 'producer.network.request',
    REQUEST_TIMEOUT: 'producer.network.request_timeout',
    REQUEST_QUEUE_SIZE: 'producer.network.request_queue_size',
  } as const;

  /**
   * @param route - Delivers a produced message to every consumer subscribed to
   * the topic. Modelling this is what makes a request-reply round trip
   * observable: without it `send` records and the message never arrives, so a
   * responder is never invoked and every RPC test would time out.
   */
  constructor(route: ((topic: string, value: string) => Promise<void>) | null = null) {
    this.#calls = [];
    this.#route = route;
  }

  #record(method: string, args: unknown[]): void {
    this.#calls.push({ method, args: [...args] });
  }

  /** All recorded method calls. */
  get calls(): Array<{ method: string; args: unknown[] }> {
    return [...this.#calls];
  }

  /**
   * Registers an event listener, RECORDING the name and rejecting the names
   * the real kafkajs rejects.
   *
   * Corrected (X28-1): this fake used to have no `on` at all, so the broker's
   * wrong event name reached nothing and the no-op guard branch hid the
   * defect. kafkajs validates the string against the VALUES of
   * `producer.events` and throws `KafkaJSNonRetriableError` for a key — this
   * double now does the same, so a wrong name fails the tests instead of
   * passing through silently.
   *
   * @param event - A wire value of {@linkcode events}, NOT its uppercase key
   */
  on(event: string, listener: (...args: unknown[]) => void): void {
    this.#record('on', [event, listener]);
    const accepted = Object.values(this.events) as readonly string[];
    if (!accepted.includes(event)) {
      throw new Error(
        `Event name should be one of ${
          accepted.map((name) => `producer.events.${name}`).join(', ')
        }`,
      );
    }
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener);
    this.#listeners.set(event, set);
  }

  /**
   * Removes a listener. Real kafkajs `off` does not validate the name.
   */
  off(event: string, listener: (...args: unknown[]) => void): void {
    this.#record('off', [event, listener]);
    this.#listeners.get(event)?.delete(listener);
  }

  connect(): Promise<void> {
    this.#record('connect', []);
    return Promise.resolve();
  }

  async send(
    options: {
      topic: string;
      messages: Array<{ value: string; headers?: Record<string, string> }>;
    },
  ): Promise<void> {
    this.#record('send', [options]);
    if (this.#route) {
      for (const message of options.messages) {
        await this.#route(options.topic, message.value);
      }
    }
  }

  disconnect(): Promise<void> {
    this.#record('disconnect', []);
    return Promise.resolve();
  }
}

/**
 * Fake Kafka factory for testing.
 */
export class FakeKafkaFactory {
  #options: FakeKafkaOptions;
  #calls: Array<{ method: string; args: unknown[] }>;
  #producers: FakeKafkaProducer[];
  #consumers: Map<string, FakeKafkaConsumer>; // groupId -> consumer
  #offset = 0;

  constructor(options: FakeKafkaOptions = {}) {
    this.#options = options;
    this.#calls = [];
    this.#producers = [];
    this.#consumers = new Map();
  }

  /** Consumer group IDs created so far, in creation order. */
  get groupIds(): string[] {
    return [...this.#consumers.keys()];
  }

  #record(method: string, args: unknown[]): void {
    this.#calls.push({ method, args: [...args] });
  }

  /** All recorded method calls. */
  get calls(): Array<{ method: string; args: unknown[] }> {
    return [...this.#calls];
  }

  producer(): FakeKafkaProducer {
    this.#record('producer', []);
    // Return existing producer, or create a new one
    if (this.#producers.length === 0) {
      const producer = new FakeKafkaProducer(
        (topic, value) => this.route(topic, value),
      );
      this.#producers.push(producer);
    }
    return this.#producers[0];
  }

  /**
   * Delivers a produced message to every consumer subscribed to `topic`,
   * preserving the per-`groupId` consumer map and the commit-on-resolve
   * modelling. Consumer groups are distinct here, so each subscribed group
   * receives its own copy — which is exactly how Kafka fans a reply topic out
   * to per-instance inbox groups.
   */
  async route(topic: string, value: string): Promise<void> {
    const message = new FakeKafkaMessage(
      value,
      String(this.#offset++),
      '0',
      {},
    );
    for (const consumer of this.#consumers.values()) {
      const subscribed = consumer.calls.some((c) =>
        c.method === 'subscribe' && (c.args[0] as { topic: string })?.topic === topic
      );
      if (subscribed) {
        await consumer.deliver(topic, message, 0);
      }
    }
  }

  consumer(options: { groupId: string }): FakeKafkaConsumer {
    this.#record('consumer', [options]);
    // Return existing consumer for this groupId, or create a new one
    if (!this.#consumers.has(options.groupId)) {
      const consumer = new FakeKafkaConsumer(
        options.groupId,
        this.#options.rejectStop,
        this.#options.seededMessages,
      );
      this.#consumers.set(options.groupId, consumer);
    }
    return this.#consumers.get(options.groupId)!;
  }

  /** Deliver all seeded messages to matching consumers. */
  async deliverAll(): Promise<void> {
    if (!this.#options.seededMessages) {
      return;
    }
    for (const seeded of this.#options.seededMessages) {
      const message = new FakeKafkaMessage(
        seeded.value,
        seeded.offset,
        seeded.timestamp,
        seeded.headers,
      );
      for (const consumer of this.#consumers.values()) {
        if (
          consumer.calls.some((c) =>
            c.method === 'subscribe' && (c.args[0] as { topic: string })?.topic === seeded.topic
          )
        ) {
          await consumer.deliver(seeded.topic, message, seeded.partition);
        }
      }
    }
  }
}
