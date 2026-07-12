/**
 * Fake Kafka client for testing KafkaBroker.
 *
 * Records all method calls and simulates Kafka behavior.
 */
export interface FakeKafkaOptions {
  /** Pre-seeded messages for eachMessage callbacks. */
  seededMessages?: Array<{
    topic: string;
    value: string;
    partition: number;
    offset: string;
    timestamp: string;
    headers: Record<string, string>;
  }>;
  /** Whether stop() should reject. */
  rejectStop?: boolean;
}

/**
 * Fake Kafka message.
 */
export class FakeKafkaMessage {
  #value: Uint8Array;
  #partition: number;
  #offset: string;
  #timestamp: string;
  #headers: Record<string, Uint8Array>;
  #key: Uint8Array | null;

  constructor(
    value: string,
    partition: number,
    offset: string,
    timestamp: string,
    headers: Record<string, string>,
    key: string | null = null,
  ) {
    this.#value = new TextEncoder().encode(value);
    this.#partition = partition;
    this.#offset = offset;
    this.#timestamp = timestamp;
    this.#headers = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k, new TextEncoder().encode(v)]),
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

  get headers(): Record<string, Uint8Array> {
    return { ...this.#headers };
  }

  get partition(): number {
    return this.#partition;
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
    headers: Record<string, string>;
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
      headers: Record<string, string>;
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
   */
  async #deliverAndTrack(topic: string, message: FakeKafkaMessage): Promise<void> {
    if (!this.#runOptions) {
      return;
    }
    try {
      await this.#runOptions.eachMessage({ topic, partition: message.partition, message });
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
    for (const msg of this.#seededMessages) {
      if (this.#subscribedTopics.includes(msg.topic)) {
        void this.#deliverAndTrack(
          msg.topic,
          new FakeKafkaMessage(msg.value, msg.partition, msg.offset, msg.timestamp, msg.headers),
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

  /** Deliver a seeded message to the eachMessage handler (tracks commit-on-resolve). */
  async deliver(topic: string, message: FakeKafkaMessage): Promise<void> {
    if (this.#running && this.#runOptions) {
      await this.#deliverAndTrack(topic, message);
    }
  }
}

/**
 * Fake Kafka producer.
 */
export class FakeKafkaProducer {
  #calls: Array<{ method: string; args: unknown[] }>;

  constructor() {
    this.#calls = [];
  }

  #record(method: string, args: unknown[]): void {
    this.#calls.push({ method, args: [...args] });
  }

  /** All recorded method calls. */
  get calls(): Array<{ method: string; args: unknown[] }> {
    return [...this.#calls];
  }

  connect(): Promise<void> {
    this.#record('connect', []);
    return Promise.resolve();
  }

  send(
    options: {
      topic: string;
      messages: Array<{ value: string; headers?: Record<string, string> }>;
    },
  ): Promise<void> {
    this.#record('send', [options]);
    return Promise.resolve();
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

  constructor(options: FakeKafkaOptions = {}) {
    this.#options = options;
    this.#calls = [];
    this.#producers = [];
    this.#consumers = new Map();
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
      const producer = new FakeKafkaProducer();
      this.#producers.push(producer);
    }
    return this.#producers[0];
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
        seeded.partition,
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
          await consumer.deliver(seeded.topic, message);
        }
      }
    }
  }
}
