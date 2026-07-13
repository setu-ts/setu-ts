import { Buffer } from 'node:buffer';

/**
 * Fake AMQP 0-9-1 client for testing RabbitMqBroker.
 *
 * Records all method calls and simulates RabbitMQ behavior. Mirrors the real
 * amqplib contract where it matters: `publish` rejects content that is not a
 * Node `Buffer` (amqplib's frame codec throws `TypeError('content is not a
 * buffer')`), so a regression to a string/Uint8Array payload fails the suite
 * instead of passing silently.
 */
export interface FakeAmqpOptions {
  /** Whether to reject on createChannel. */
  rejectCreateChannel?: boolean;
  /** Whether to reject on publish. */
  rejectPublish?: boolean;
  /** Pre-seeded messages for consume callbacks. */
  seededMessages?: Array<{
    topic: string;
    content: string;
    properties: Record<string, unknown>;
  }>;
  /** Whether to deliver a null message (consumer-cancel notification). */
  deliverNull?: boolean;
}

/**
 * Fake AMQP channel for testing.
 */
export class FakeAmqpChannel {
  #options: FakeAmqpOptions;
  #calls: Array<{ method: string; args: unknown[] }>;
  #consumers: Array<{
    queue: string;
    callback: (msg: unknown) => void;
    consumerTag: string;
  }>;
  #consumerTagCounter = 0;

  constructor(options: FakeAmqpOptions = {}) {
    this.#options = options;
    this.#calls = [];
    this.#consumers = [];
  }

  #record(method: string, args: unknown[]): void {
    this.#calls.push({ method, args: [...args] });
  }

  /** All recorded method calls. */
  get calls(): Array<{ method: string; args: unknown[] }> {
    return [...this.#calls];
  }

  assertExchange(exchange: string, type: string, _options?: unknown): Promise<void> {
    this.#record('assertExchange', [exchange, type, _options]);
    // Idempotent - always succeeds
    return Promise.resolve();
  }

  assertQueue(queue: string, _options?: unknown): Promise<{ queue: string }> {
    this.#record('assertQueue', [queue, _options]);
    return Promise.resolve({ queue });
  }

  bindQueue(queue: string, source: string, pattern: string): Promise<void> {
    this.#record('bindQueue', [queue, source, pattern]);
    return Promise.resolve();
  }

  publish(
    exchange: string,
    routingKey: string,
    content: unknown,
    properties?: unknown,
  ): Promise<boolean> {
    // Faithful to amqplib: the frame codec requires a Node Buffer and throws
    // for a string or a Uint8Array (Buffer.isBuffer(new Uint8Array()) === false).
    if (!Buffer.isBuffer(content)) {
      throw new TypeError('content is not a buffer');
    }
    this.#record('publish', [exchange, routingKey, content, properties]);
    if (this.#options.rejectPublish) {
      throw new Error('Publish failed');
    }
    return Promise.resolve(true);
  }

  consume(
    queue: string,
    callback: (msg: unknown) => void,
    _options?: unknown,
  ): Promise<{ consumerTag: string }> {
    this.#record('consume', [queue, typeof callback, _options]);
    const consumerTag = `consumer-${this.#consumerTagCounter++}`;
    this.#consumers.push({ queue, callback, consumerTag });

    // Deliver null message for consumer-cancel notification
    if (this.#options.deliverNull) {
      callback(null);
    }

    // Deliver seeded messages
    if (this.#options.seededMessages) {
      for (const seeded of this.#options.seededMessages) {
        const msg = createFakeMessage(seeded.content, seeded.properties);
        callback(msg);
      }
    }

    return Promise.resolve({ consumerTag });
  }

  ack(msg: unknown): void {
    this.#record('ack', [msg]);
  }

  nack(msg: unknown, allUpTo: boolean, requeue: boolean): void {
    this.#record('nack', [msg, allUpTo, requeue]);
  }

  cancel(tag: string): Promise<void> {
    this.#record('cancel', [tag]);
    const idx = this.#consumers.findIndex((c) => c.consumerTag === tag);
    if (idx !== -1) {
      this.#consumers.splice(idx, 1);
    }
    return Promise.resolve();
  }

  deleteQueue(queue: string): Promise<void> {
    this.#record('deleteQueue', [queue]);
    return Promise.resolve();
  }
}

/**
 * Fake AMQP connection for testing.
 */
export class FakeAmqpConnection {
  #options: FakeAmqpOptions;
  #channel: FakeAmqpChannel | null = null;

  constructor(options: FakeAmqpOptions = {}) {
    this.#options = options;
  }

  createChannel(): Promise<FakeAmqpChannel> {
    if (this.#options.rejectCreateChannel) {
      throw new Error('createChannel failed');
    }
    if (!this.#channel) {
      this.#channel = new FakeAmqpChannel(this.#options);
    }
    return Promise.resolve(this.#channel);
  }

  close(): Promise<void> {
    this.#channel = null;
    return Promise.resolve();
  }
}

/**
 * Helper to create a fake AMQP message.
 */
function createFakeMessage(content: string, properties: Record<string, unknown>): unknown {
  return {
    // Real amqplib delivers message content as a Node Buffer.
    content: Buffer.from(content, 'utf8'),
    fields: { routingKey: 'test-topic' },
    properties,
  };
}
