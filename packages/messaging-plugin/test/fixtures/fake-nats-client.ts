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
    timestamp: string;
  }>;
  /** Whether streams.info should throw a generic error (not 'stream not found'). */
  rejectStreamInfo?: boolean;
}

/**
 * Fake JetStream message.
 */
export class FakeNatsMessage {
  #data: Uint8Array;
  #seq: number;
  #timestamp: string;
  #acked = false;
  #naked = false;

  constructor(data: string, seq: number, timestamp: string) {
    this.#data = new TextEncoder().encode(data);
    this.#seq = seq;
    this.#timestamp = timestamp;
  }

  get data(): Uint8Array {
    return this.#data;
  }

  get seq(): number {
    return this.#seq;
  }

  get info(): { timestamp: string } {
    return { timestamp: this.#timestamp };
  }

  get headers(): unknown {
    return undefined;
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
  #stopped = false;

  constructor(messages: FakeNatsMessage[]) {
    this.#messages = messages;
  }

  consume(options: { callback: (msg: FakeNatsMessage) => void }): unknown {
    // Deliver messages using the callback from options
    for (const msg of this.#messages) {
      if (!this.#stopped) {
        options.callback(msg);
      }
    }
    return {
      stop: () => {
        this.#stopped = true;
      },
    };
  }

  stop(): void {
    this.#stopped = true;
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

  constructor(rejectStreamInfo: boolean = false) {
    this.#streams = new Set();
    this.#consumers = new Map();
    this.#calls = [];
    this.#rejectStreamInfo = rejectStreamInfo;
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
      this.#streams.add(config.name);
      this.#consumers.set(config.name, new Set());
      return Promise.resolve({ name: config.name });
    },
  };

  consumers = {
    add: (stream: string, config: unknown): Promise<{ name: string }> => {
      this.#record('consumers.add', [stream, config]);
      const cfg = config as { name: string };
      if (!this.#consumers.has(stream)) {
        this.#consumers.set(stream, new Set());
      }
      this.#consumers.get(stream)!.add(cfg.name);
      return Promise.resolve({ name: cfg.name });
    },
    get: (stream: string, consumer: string): Promise<FakeNatsConsumer> => {
      this.#record('consumers.get', [stream, consumer]);
      return Promise.resolve(new FakeNatsConsumer([]));
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

  constructor(
    seedMessages: Array<{ subject: string; data: string; seq: number; timestamp: string }>,
  ) {
    this.#calls = [];
    this.#seededMessages = new Map();
    for (const msg of seedMessages) {
      if (!this.#seededMessages.has(msg.subject)) {
        this.#seededMessages.set(msg.subject, []);
      }
      this.#seededMessages.get(msg.subject)!.push(
        new FakeNatsMessage(msg.data, msg.seq, msg.timestamp),
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

  publish(subject: string, data: Uint8Array): void {
    this.#record('publish', [subject, data]);
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
      // Return consumer with seeded messages
      const messages: FakeNatsMessage[] = [];
      for (const [_subject, msgs] of this.#seededMessages.entries()) {
        messages.push(...msgs);
      }
      return Promise.resolve(new FakeNatsConsumer(messages));
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
    if (!this.#jsm) {
      this.#jsm = new FakeNatsJetStreamManager(this.#options.rejectStreamInfo);
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

  close(): void {
    this.#closed = true;
    this.#js = null;
    this.#jsm = null;
  }
}
