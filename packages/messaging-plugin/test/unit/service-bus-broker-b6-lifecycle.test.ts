/**
 * B6 lifecycle tests for ServiceBusBroker.
 *
 * These tests exercise the broker's public request() so its private
 * #openReplyInbox implementation, admin createSubscription, and transport
 * open actually run. They use recording/deferred fake transports.
 *
 * Covers:
 *   A. Concurrent FIRST request() calls share single inbox init
 *   B. Partial open failure with compensation
 *   C. Teardown idempotency
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRuntimeServices } from '@hono-enterprise/common';
import { ServiceBusBroker } from '../../src/brokers/service-bus-broker.ts';
import type { IServiceBusTransport } from '../../src/brokers/service-bus-broker.ts';

/* ------------------------------------------------------------------ */
/*  Test harness                                                      */
/* ------------------------------------------------------------------ */

let uuidCounter = 0;
function createRuntime(platform: string = 'node'): IRuntimeServices {
  return {
    platform: () => platform as ReturnType<IRuntimeServices['platform']>,
    uuid: () => `uuid-${++uuidCounter}`,
    now: () => 1000000,
    setTimeout: (fn: () => void, ms: number) => {
      return (setTimeout(fn, ms) as unknown) as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
      clearTimeout(handle as unknown as number);
    },
    setInterval: () => (1 as unknown as ReturnType<typeof setInterval>),
    clearInterval: () => {},
    randomBytes: () => new Uint8Array(16),
    subtle: undefined,
    hostname: 'test',
    version: '0.1.0',
    hrtime: () => 0,
    fs: undefined,
    env: {},
    exit: () => {},
  } as unknown as IRuntimeServices;
}

/** Deferred promise helper. */
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err?: unknown) => void;
}

function createDeferred(): Deferred {
  let res!: () => void;
  let rej!: (err?: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    res = resolve;
    rej = reject;
  });
  return { promise, resolve: res, reject: rej };
}

/* ------------------------------------------------------------------ */
/*  A. Concurrent FIRST request() calls share inbox init              */
/* ------------------------------------------------------------------ */

describe('ServiceBusBroker B6 lifecycle', () => {
  describe('A. Concurrent FIRST request() calls', () => {
    it('two concurrent requests while inbox init deferred: single admin create, single transport open', async () => {
      let createSubCount = 0;
      let openCount = 0;
      const inboxDeferred = createDeferred();

      const transport: IServiceBusTransport = {
        send: () => Promise.resolve(),
        createSubscription: () => {
          createSubCount++;
          return Promise.resolve();
        },
        deleteSubscription: () => Promise.resolve(),
        open: async () => {
          openCount++;
          await inboxDeferred.promise;
          return { close: () => Promise.resolve() };
        },
        close: () => Promise.resolve(),
      };

      const broker = new ServiceBusBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();

      // Start two concurrent requests — both trigger #ensureInbox which calls
      // #openReplyInbox, but the promise is memoized so it runs once.
      const req1 = broker.request<string, string>('topic', 'hello-1', { timeoutMs: 10000 });
      const req2 = broker.request<string, string>('topic', 'hello-2', { timeoutMs: 10000 });

      // Allow time for #ensureInbox to run
      await new Promise((r) => setTimeout(r, 20));

      // Both should have triggered the same inbox init (deferred).
      expect(createSubCount).toBe(1);
      expect(openCount).toBe(1);

      // Resolve the deferred so inbox opens complete
      inboxDeferred.resolve();

      // Requests will timeout without a responder, but we proved memoization
      // Cancel by disconnecting
      await broker.disconnect();

      try {
        await Promise.race([req1, req2]);
      } catch {
        // Expected — broker disconnected.
      }
    });
  });

  /* ---------------------------------------------------------------- */
  /*  B. Partial open failure with compensation                       */
  /* ---------------------------------------------------------------- */

  describe('B. Partial open failure with compensation', () => {
    it('admin create succeeds, transport open fails: deleteSubscription called once', async () => {
      let createSubCount = 0;
      let openCount = 0;
      let deleteSubCount = 0;
      const inboxDeferred = createDeferred();
      let shouldFail = false;

      const transport: IServiceBusTransport = {
        send: () => Promise.resolve(),
        createSubscription: () => {
          createSubCount++;
          return Promise.resolve();
        },
        deleteSubscription: () => {
          deleteSubCount++;
          return Promise.resolve();
        },
        open: async () => {
          openCount++;
          await inboxDeferred.promise;
          if (shouldFail) {
            throw new Error('transport open failed');
          }
          return { close: () => Promise.resolve() };
        },
        close: () => Promise.resolve(),
      };

      const broker = new ServiceBusBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();

      // First request: admin create succeeds, transport open fails.
      shouldFail = true;
      const req1 = broker.request<string, string>('topic', 'hello', { timeoutMs: 10000 });

      // Let deferred resolve so open can execute and fail.
      inboxDeferred.resolve();

      let firstError: Error | null = null;
      try {
        await req1;
      } catch (err) {
        firstError = err as Error;
      }

      expect(firstError).not.toBeNull();
      expect(createSubCount).toBe(1);
      expect(openCount).toBe(1);
      expect(deleteSubCount).toBe(1); // compensation

      await broker.disconnect();
    });

    it('failed inbox not cached: second request retries create and open successfully', async () => {
      let createSubCount = 0;
      let openCount = 0;
      let deleteSubCount = 0;
      let inboxDeferred = createDeferred();
      let shouldFail = true;

      const transport: IServiceBusTransport = {
        send: () => Promise.resolve(),
        createSubscription: () => {
          createSubCount++;
          return Promise.resolve();
        },
        deleteSubscription: () => {
          deleteSubCount++;
          return Promise.resolve();
        },
        open: async () => {
          openCount++;
          await inboxDeferred.promise;
          if (shouldFail) {
            throw new Error('transport open failed');
          }
          return { close: () => Promise.resolve() };
        },
        close: () => Promise.resolve(),
      };

      const broker = new ServiceBusBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();

      // First request fails
      const req1 = broker.request<string, string>('topic', 'hello', { timeoutMs: 10000 });
      inboxDeferred.resolve();

      let firstError: Error | null = null;
      try {
        await req1;
      } catch (err) {
        firstError = err as Error;
      }
      expect(firstError).not.toBeNull();

      // Second request: now succeed
      shouldFail = false;
      inboxDeferred = createDeferred();
      const req2 = broker.request<string, string>('topic', 'hello-2', { timeoutMs: 10000 });
      // Wait for deferred to be awaited
      await new Promise((r) => setTimeout(r, 20));
      inboxDeferred.resolve();

      // req2 will still timeout without a responder, but create/open ran again
      await new Promise((r) => setTimeout(r, 20));

      expect(createSubCount).toBe(2); // first + retry
      expect(openCount).toBe(2);

      await broker.disconnect();

      try {
        await req2;
      } catch {
        // Expected timeout/disconnect.
      }
    });
  });

  /* ---------------------------------------------------------------- */
  /*  C. Teardown idempotency                                         */
  /* ---------------------------------------------------------------- */

  describe('C. Teardown idempotency', () => {
    it('disconnect called twice: transport close once, subscription close and admin delete each once', async () => {
      let transportCloseCount = 0;
      let subCloseCount = 0;
      let adminDeleteCount = 0;
      const inboxDeferred = createDeferred();

      const transport: IServiceBusTransport = {
        send: () => Promise.resolve(),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => {
          adminDeleteCount++;
          return Promise.resolve();
        },
        open: async () => {
          await inboxDeferred.promise;
          return {
            close: () => {
              subCloseCount++;
              return Promise.resolve();
            },
          };
        },
        close: () => {
          transportCloseCount++;
          return Promise.resolve();
        },
      };

      const broker = new ServiceBusBroker(createRuntime(), {
        serialize: (v) => JSON.stringify(v),
        deserialize: (s) => JSON.parse(s),
      }, { client: transport });

      await broker.connect();

      // Trigger inbox open
      const reqPromise = broker.request<string, string>('topic', 'test', { timeoutMs: 5000 });
      inboxDeferred.resolve();
      await new Promise((r) => setTimeout(r, 20));

      // First disconnect
      await broker.disconnect();
      const firstTransportClose = transportCloseCount;
      const firstSubClose = subCloseCount;
      const firstAdminDelete = adminDeleteCount;

      // Second disconnect should be idempotent
      await broker.disconnect();

      expect(transportCloseCount).toBe(firstTransportClose);
      expect(subCloseCount).toBe(firstSubClose);
      expect(adminDeleteCount).toBe(firstAdminDelete);

      try {
        await reqPromise;
      } catch {
        // Expected — broker disconnected.
      }
    });
  });
});
