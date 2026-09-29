/**
 * Transparency of `createObservedFetch` (M98n §3.3): the wrapped fetch sees
 * exactly the arguments and receiver it would see unwrapped, is called once,
 * and its result or thrown value reaches the caller unchanged — while the
 * observation reads nothing but `status`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IOutboundHttpDiagnosticsSource, IPluginContext } from '@setu-ts/common';

import { createObservedFetch } from '../../src/http/observed-fetch.ts';
import { createClient } from '../../src/sdk.ts';

type Fetch = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

/** A Proxy that records every trap it sees. */
function recordingProxy<T extends object>(target: T, log: string[]): T {
  return new Proxy(target, {
    get(t, key, receiver) {
      log.push(`get:${String(key)}`);
      return Reflect.get(t, key, receiver);
    },
    has(t, key) {
      log.push(`has:${String(key)}`);
      return Reflect.has(t, key);
    },
    ownKeys(t) {
      log.push('ownKeys');
      return Reflect.ownKeys(t);
    },
    getOwnPropertyDescriptor(t, key) {
      log.push(`gopd:${String(key)}`);
      return Reflect.getOwnPropertyDescriptor(t, key);
    },
  });
}

describe('createObservedFetch — arguments are forwarded unread', () => {
  it('passes the caller argument list (same identities, same arity) and reads none of it', async () => {
    const log: string[] = [];
    const input = recordingProxy(
      new Request('https://canary-host.example/secret?token=canary'),
      log,
    );
    const init = recordingProxy({ headers: { Authorization: 'Bearer canary' } }, log);
    const seen: unknown[][] = [];
    const observed = createObservedFetch({
      alias: 'payments',
      fetch: (...args: unknown[]) => {
        seen.push(args);
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    await observed.fetch(input, init);
    await observed.fetch(input);
    expect(seen[0]!.length).toBe(2);
    expect(seen[0]![0]).toBe(input);
    expect(seen[0]![1]).toBe(init);
    expect(seen[1]!.length).toBe(1);
    expect(log).toEqual([]);
  });

  it('calls the wrapped fetch exactly once per call', async () => {
    let calls = 0;
    const observed = createObservedFetch({
      alias: 'payments',
      fetch: () => {
        calls++;
        return Promise.resolve(new Response('x'));
      },
    });
    await observed.fetch('https://example.test/');
    expect(calls).toBe(1);
  });
});

describe('createObservedFetch — receiver rule', () => {
  function receiverRecorder(receivers: unknown[]): Fetch {
    return function (this: unknown): Promise<Response> {
      receivers.push(this);
      return Promise.resolve(new Response(null, { status: 200 }));
    };
  }

  it('forwards undefined for a direct call on the helper object', async () => {
    const receivers: unknown[] = [];
    const observed = createObservedFetch({ alias: 'a', fetch: receiverRecorder(receivers) });
    await observed.fetch('https://example.test/');
    expect(receivers).toEqual([undefined]);
  });

  it('forwards undefined for a destructured call', async () => {
    const receivers: unknown[] = [];
    const { fetch } = createObservedFetch({ alias: 'a', fetch: receiverRecorder(receivers) });
    await fetch('https://example.test/');
    expect(receivers).toEqual([undefined]);
  });

  it('forwards any other receiver unchanged, including the SDK client', async () => {
    const receivers: unknown[] = [];
    const observed = createObservedFetch({ alias: 'a', fetch: receiverRecorder(receivers) });
    const other = { marker: true };
    await observed.fetch.call(other, 'https://example.test/');
    await observed.fetch.call(observed, 'https://example.test/');
    const client = createClient({ baseUrl: 'https://example.test', fetch: observed.fetch });
    await client.request({ method: 'GET', path: 'x' });
    expect(receivers[0]).toBe(other);
    expect(receivers[1]).toBe(undefined);
    expect(receivers[2]).not.toBe(undefined);
    expect(receivers[2]).not.toBe(observed);
  });

  it('is not constructible, like fetch, and differs from it only in length', () => {
    const observed = createObservedFetch({
      alias: 'a',
      fetch: () => Promise.resolve(new Response()),
    });
    const Ctor = observed.fetch as unknown as new () => unknown;
    expect(() => new Ctor()).toThrow(TypeError);
    expect(observed.fetch.name).toBe('fetch');
    expect(observed.fetch.length).toBe(0);
  });
});

describe('createObservedFetch — result fidelity', () => {
  it('resolves with the identical Response and leaves its body untouched', async () => {
    const response = new Response('body-canary', { status: 201 });
    const observed = createObservedFetch({ alias: 'a', fetch: () => Promise.resolve(response) });
    const result = await observed.fetch('https://example.test/');
    expect(result).toBe(response);
    expect(result.bodyUsed).toBe(false);
    expect(result.body?.locked).toBe(false);
    expect(await result.text()).toBe('body-canary');
  });

  it('rejects with the identical reason and counts a failure', async () => {
    const reason = { secret: 'canary' };
    const observed = createObservedFetch({ alias: 'a', fetch: () => Promise.reject(reason) });
    let caught: unknown;
    try {
      await observed.fetch('https://example.test/');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
  });

  it('rethrows a synchronous throw synchronously, with the identical value', () => {
    const error = new Error('sync-canary');
    const observed = createObservedFetch({
      alias: 'a',
      fetch: () => {
        throw error;
      },
    });
    let caught: unknown;
    try {
      void observed.fetch('https://example.test/');
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBe(error);
  });

  it('adopts a non-Promise return and a thenable the way await would', async () => {
    const response = new Response(null, { status: 200 });
    const direct = createObservedFetch({
      alias: 'a',
      fetch: (() => response) as unknown as Fetch,
    });
    expect(await direct.fetch('https://example.test/')).toBe(response);
    const thenable = createObservedFetch({
      alias: 'b',
      fetch: (() => ({
        then(resolve: (value: Response) => void) {
          resolve(response);
        },
      })) as unknown as Fetch,
    });
    expect(await thenable.fetch('https://example.test/')).toBe(response);
  });

  it('turns a throwing promise constructor getter into a recorded rejection, as await does', async () => {
    const fault = new Error('constructor getter');
    const hostile = () => {
      const promise = Promise.resolve(new Response(null));
      Object.defineProperty(promise, 'constructor', {
        get() {
          throw fault;
        },
      });
      return promise;
    };
    // Unwrapped baseline: the fault surfaces only at `await`.
    let unwrapped: unknown;
    try {
      await hostile();
    } catch (thrown) {
      unwrapped = thrown;
    }
    expect(unwrapped).toBe(fault);

    const observed = createObservedFetch({ alias: 'a', fetch: hostile as unknown as Fetch });
    let returned: Promise<Response> | undefined;
    expect(() => {
      returned = observed.fetch('https://example.test/');
    }).not.toThrow();
    let wrapped: unknown;
    try {
      await returned;
    } catch (thrown) {
      wrapped = thrown;
    }
    expect(wrapped).toBe(fault);
    let source: IOutboundHttpDiagnosticsSource | undefined;
    await observed.plugin.register({
      app: {},
      services: {
        register(_token: string, service: unknown) {
          source = service as IOutboundHttpDiagnosticsSource;
        },
      },
      lifecycle: { onClose() {} },
    } as unknown as IPluginContext);
    if (source === undefined) throw new Error('source not registered');
    expect(source.snapshot().records[0]).toMatchObject({ started: 1, count: 1, failures: 1 });
  });

  it('adopts a native promise exactly as await does: one constructor read, no own then', async () => {
    const response = new Response(null, { status: 200 });
    // An own `then` that throws, one that counts, and a constructor getter
    // that answers Promise once and throws after — `await` survives all three.
    const cases: {
      name: string;
      make: () => { promise: Promise<Response>; calls: () => number };
    }[] = [
      {
        name: 'own throwing then',
        make: () => {
          const promise = Promise.resolve(response);
          Object.defineProperty(promise, 'then', {
            value: () => {
              throw new Error('own then');
            },
          });
          return { promise, calls: () => 0 };
        },
      },
      {
        name: 'own counting then',
        make: () => {
          let count = 0;
          const promise = Promise.resolve(response);
          const original = promise.then.bind(promise);
          Object.defineProperty(promise, 'then', {
            value: (...args: Parameters<typeof original>) => {
              count++;
              return original(...args);
            },
          });
          return { promise, calls: () => count };
        },
      },
      {
        name: 'constructor throwing on the second read',
        make: () => {
          let reads = 0;
          const promise = Promise.resolve(response);
          Object.defineProperty(promise, 'constructor', {
            get() {
              reads++;
              if (reads > 1) throw new Error('second constructor read');
              return Promise;
            },
          });
          return { promise, calls: () => reads - 1 };
        },
      },
    ];
    for (const entry of cases) {
      const unwrapped = entry.make();
      expect(await unwrapped.promise).toBe(response);
      const wrappedCase = entry.make();
      const observed = createObservedFetch({
        alias: 'a',
        fetch: (() => wrappedCase.promise) as unknown as Fetch,
      });
      let returned: Promise<Response> | undefined;
      expect(() => {
        returned = observed.fetch('https://example.test/');
      }, entry.name).not.toThrow();
      expect(await returned, entry.name).toBe(response);
      expect(wrappedCase.calls(), entry.name).toBe(unwrapped.calls());
    }
  });

  it('reads only status on the resolved value, and a throwing status getter changes nothing', async () => {
    // Promise resolution itself reads `then`; compare against the unwrapped
    // baseline so only observation-code reads remain.
    async function reads(wrap: boolean): Promise<string[]> {
      const log: string[] = [];
      const value = recordingProxy(
        { status: 200, headers: 'canary', url: 'canary', body: 'canary' },
        log,
      ) as unknown as Response;
      const inner: Fetch = () => Promise.resolve(value);
      const call = wrap ? createObservedFetch({ alias: 'a', fetch: inner }).fetch : inner;
      await call('https://example.test/');
      return log;
    }
    const unwrapped = await reads(false);
    const wrapped = await reads(true);
    const extra = [...wrapped];
    for (const entry of unwrapped) {
      extra.splice(extra.indexOf(entry), 1);
    }
    // `status` is the observation's only read. The one extra `then` is the
    // derived promise resolving with the value — the same thenable check
    // `await` performs, and the one added resolution step §3.3 documents.
    expect(extra).toEqual(['get:status', 'get:then']);

    const hostile = {
      get status(): number {
        throw new Error('status-canary');
      },
    } as unknown as Response;
    const throwing = createObservedFetch({ alias: 'b', fetch: () => Promise.resolve(hostile) });
    expect(await throwing.fetch('https://example.test/')).toBe(hostile);
  });

  it('adds exactly one microtask relative to the unwrapped fetch', async () => {
    const order: string[] = [];
    const inner: Fetch = () => Promise.resolve(new Response());
    const observed = createObservedFetch({ alias: 'a', fetch: inner });
    const raw = inner('https://example.test/').then(() => order.push('raw'));
    const wrapped = observed.fetch('https://example.test/').then(() => order.push('wrapped'));
    queueMicrotask(() => order.push('tick1'));
    await Promise.all([raw, wrapped]);
    expect(order[0]).toBe('raw');
    expect(order).toContain('wrapped');
  });
});

describe('createObservedFetch — default transport', () => {
  it('uses the call-time globalThis.fetch with the global as receiver when fetch is omitted', async () => {
    const original = globalThis.fetch;
    const receivers: unknown[] = [];
    globalThis.fetch = function (this: unknown): Promise<Response> {
      receivers.push(this);
      return Promise.resolve(new Response(null, { status: 202 }));
    } as typeof fetch;
    try {
      const observed = createObservedFetch({ alias: 'a' });
      const response = await observed.fetch('https://example.test/');
      expect(response.status).toBe(202);
      expect(receivers[0] === undefined || receivers[0] === globalThis).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('createObservedFetch — unhandled rejections', () => {
  it('reports a dropped rejection exactly once, identically wrapped and unwrapped', async () => {
    const script = `
      import { createObservedFetch } from ${
      JSON.stringify(new URL('../../src/http/observed-fetch.ts', import.meta.url).href)
    };
      const mode = Deno.args[0];
      let reports = 0;
      globalThis.addEventListener('unhandledrejection', (event) => {
        reports++;
        event.preventDefault();
      });
      const inner = () => Promise.reject(new Error('dropped'));
      const call = mode === 'wrapped'
        ? createObservedFetch({ alias: 'a', fetch: inner }).fetch
        : inner;
      if (Deno.args[1] === 'handled') {
        call('https://example.test/').catch(() => {});
      } else {
        call('https://example.test/');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      console.log(reports);
    `;
    async function run(mode: string, handling: string): Promise<string> {
      const output = await new Deno.Command(Deno.execPath(), {
        args: ['eval', '--ext=ts', script, mode, handling],
        stdout: 'piped',
        stderr: 'piped',
      }).output();
      return new TextDecoder().decode(output.stdout).trim();
    }
    expect(await run('raw', 'dropped')).toBe('1');
    expect(await run('wrapped', 'dropped')).toBe('1');
    expect(await run('wrapped', 'handled')).toBe('0');
  });
});
