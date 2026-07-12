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
  #subject: string;
  #acked = false;
  #naked = false;

  constructor(data: string, seq: number, timestamp: string, subject: string) {
    this.#data = new TextEncoder().encode(data);
    this.#seq = seq;
    this.#timestamp = timestamp;
    this.#subject = subject;
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
  #filterSubject: string | undefined;
  #stopped = false;

  constructor(messages: FakeNatsMessage[], filterSubject?: string) {
    this.#messages = messages;
    this.#filterSubject = filterSubject;
  }

  consume(options: { callback: (msg: FakeNatsMessage) => void }): unknown {
    // Deliver messages using the callback from options, filtered by subject if filterSubject is set
    for (const msg of this.#messages) {
      if (!this.#stopped) {
        // If filterSubject is set, only deliver messages matching the filter
        if (this.#filterSubject === undefined || msg.subject === this.#filterSubject) {
          options.callback(msg);
        }
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
        new FakeNatsMessage(msg.data, msg.seq, msg.timestamp, msg.subject),
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
      // Look up the consumer's filter_subject from the recorded add calls
      const addCall = [...this.calls, ...sharedConsumers.calls]
        .filter((c) => c.method === 'consumers.add')
        .find((c) => (c.args[1] as { name: string })?.name === consumer);
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
      return Promise.resolve(new FakeNatsConsumer(messages, filterSubject));
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
