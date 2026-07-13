/**
 * Fake AMQP 0-9-1 client for testing RabbitMqQueue.
 *
 * Records all method calls and simulates RabbitMQ behavior.
 * Faithfully mirrors the real amqplib shape including:
 * - Buffer.isBuffer(content) check on publish (throws otherwise)
 * - Returns false (not null) for empty queue on get()
 * - Routes delay queue publishes to ready queue for testing
 */

import { Buffer } from 'node:buffer';
import type { IAmqpQueueChannel, IAmqpQueueMessage } from '../../src/interfaces/index.ts';

/**
 * Options for the fake AMQP client.
 */
export interface FakeAmqpQueueOptions {
  /** Whether to reject createChannel. */
  rejectCreateChannel?: boolean;
  /** Whether to reject publish. */
  rejectPublish?: boolean;
}

/**
 * Fake AMQP channel for testing.
 */
export class FakeAmqpQueueChannel implements IAmqpQueueChannel {
  #options: FakeAmqpQueueOptions;
  #calls: Array<{ method: string; args: unknown[] }>;
  // Per-queue: buffers for ready queues
  #readyBuffers: Map<string, Array<{ content: Buffer; options: unknown }>>;
  // Per-queue: buffers for delay queues (routes to ready on publish for testing)
  #delayBuffers: Map<string, Array<{ content: Buffer; options: unknown }>>;

  constructor(options: FakeAmqpQueueOptions = {}) {
    this.#options = options;
    this.#calls = [];
    this.#readyBuffers = new Map();
    this.#delayBuffers = new Map();
  }

  #record(method: string, args: unknown[]): void {
    this.#calls.push({ method, args: [...args] });
  }

  /** All recorded method calls. */
  get calls(): Array<{ method: string; args: unknown[] }> {
    return [...this.#calls];
  }

  /** Get all buffered messages for a ready queue. */
  getReadyBuffer(queue: string): Array<{ content: Buffer; options: unknown }> {
    return this.#readyBuffers.get(queue) ?? [];
  }

  /** Get all buffered messages for a delay queue. */
  getDelayBuffer(queue: string): Array<{ content: Buffer; options: unknown }> {
    return this.#delayBuffers.get(queue) ?? [];
  }

  assertQueue(queue: string, options?: unknown): Promise<{ queue: string }> {
    this.#record('assertQueue', [queue, options]);
    // Initialize buffer if not exists
    if (!this.#readyBuffers.has(queue)) {
      this.#readyBuffers.set(queue, []);
    }
    if (!this.#delayBuffers.has(queue)) {
      this.#delayBuffers.set(queue, []);
    }
    return Promise.resolve({ queue });
  }

  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options?: unknown,
  ): boolean {
    this.#record('publish', [exchange, routingKey, content, options]);

    if (this.#options.rejectPublish) {
      throw new Error('Publish failed');
    }

    // CRITICAL: Assert Buffer.isBuffer(content) like real amqplib
    if (!Buffer.isBuffer(content)) {
      throw new TypeError('content is not a buffer');
    }

    // Route based on queue name pattern
    // Delay queues end with '.delay', route to matching ready queue
    if (routingKey.endsWith('.delay')) {
      const readyQueue = routingKey.replace('.delay', '.ready');
      if (!this.#readyBuffers.has(readyQueue)) {
        this.#readyBuffers.set(readyQueue, []);
      }
      // For testing: immediately route delay queue messages to ready queue
      // (simulates TTL expiry without waiting)
      this.#readyBuffers.get(readyQueue)!.push({
        content: Buffer.from(content),
        options,
      });
    } else {
      // Ready or dead queue
      if (!this.#readyBuffers.has(routingKey)) {
        this.#readyBuffers.set(routingKey, []);
      }
      this.#readyBuffers.get(routingKey)!.push({
        content: Buffer.from(content),
        options,
      });
    }

    return true;
  }

  get(queue: string, options?: unknown): Promise<IAmqpQueueMessage | false> {
    this.#record('get', [queue, options]);

    const buffer = this.#readyBuffers.get(queue);
    if (!buffer || buffer.length === 0) {
      // CRITICAL: Return false (BasicGetEmpty), NOT null
      return Promise.resolve(false);
    }

    const msg = buffer.shift()!;
    const message: IAmqpQueueMessage = {
      content: msg.content,
      fields: {
        deliveryTag: Math.floor(Math.random() * 1000),
      },
      properties: msg.options,
    };

    return Promise.resolve(message);
  }

  ack(message: unknown): void {
    this.#record('ack', [message]);
    // No-op: message already removed from buffer on get()
  }

  close(): Promise<void> {
    this.#record('close', []);
    this.#readyBuffers.clear();
    this.#delayBuffers.clear();
    return Promise.resolve();
  }
}

/**
 * Fake AMQP connection for testing.
 */
export class FakeAmqpQueueConnection {
  #options: FakeAmqpQueueOptions;
  #channel: FakeAmqpQueueChannel | null = null;

  constructor(options: FakeAmqpQueueOptions = {}) {
    this.#options = options;
  }

  createChannel(): Promise<FakeAmqpQueueChannel> {
    if (this.#options.rejectCreateChannel) {
      throw new Error('createChannel failed');
    }
    if (!this.#channel) {
      this.#channel = new FakeAmqpQueueChannel(this.#options);
    }
    return Promise.resolve(this.#channel);
  }

  close(): Promise<void> {
    this.#channel = null;
    return Promise.resolve();
  }
}

/**
 * Create a fake AMQP connection with optional configuration.
 */
export function createFakeAmqpConnection(
  options: FakeAmqpQueueOptions = {},
): FakeAmqpQueueConnection {
  return new FakeAmqpQueueConnection(options);
}
