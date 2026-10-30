import { vi } from 'vitest';
import type { NodeRedisClientLike } from '../../src/index.ts';

/** A node-redis shaped fake with explicit lifecycle and subscription callbacks. */
export function nodeRedisFake(): NodeRedisClientLike & {
  isOpen: boolean;
  isReady: boolean;
  connect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  sendCommand: ReturnType<typeof vi.fn<(args: readonly string[]) => Promise<unknown>>>;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  destroy: ReturnType<typeof vi.fn<() => void>>;
  on: ReturnType<
    typeof vi.fn<
      (
        event: string,
        listener: ((error: unknown) => void) | ((channel: string, message: string) => void),
      ) => void
    >
  >;
  off: ReturnType<
    typeof vi.fn<
      (
        event: string,
        listener: ((error: unknown) => void) | ((channel: string, message: string) => void),
      ) => void
    >
  >;
  subscribe: ReturnType<
    typeof vi.fn<
      (channel: string, listener: (message: string, channel: string) => void) => Promise<void>
    >
  >;
  unsubscribe: ReturnType<typeof vi.fn<(channel: string) => Promise<void>>>;
} {
  const client = {
    isOpen: false,
    isReady: false,
    connect: vi.fn(() => {
      client.isOpen = true;
      client.isReady = true;
      return Promise.resolve();
    }),
    sendCommand: vi.fn((_args: readonly string[]): Promise<unknown> => Promise.resolve('OK')),
    close: vi.fn(() => {
      client.isOpen = false;
      client.isReady = false;
      return Promise.resolve();
    }),
    destroy: vi.fn(() => {
      client.isOpen = false;
      client.isReady = false;
    }),
    on: vi.fn(
      (
        _event: string,
        _listener: ((error: unknown) => void) | ((channel: string, message: string) => void),
      ) => {},
    ),
    off: vi.fn(
      (
        _event: string,
        _listener: ((error: unknown) => void) | ((channel: string, message: string) => void),
      ) => {},
    ),
    subscribe: vi.fn(
      async (_channel: string, _listener: (message: string, channel: string) => void) => {},
    ),
    unsubscribe: vi.fn(async (_channel: string) => {}),
  };
  return client;
}
