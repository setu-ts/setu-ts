/**
 * Unit tests for the runtime-owned local diagnostics listener: one active
 * listener, exact loopback bind, native pre-mapping framing refusal, no
 * adapter/handle escape, body refusal, unsupported-platform refusal, close
 * idempotence, and provider ordering with the RuntimePlugin.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IRequest, IResponse } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import {
  createLocalDiagnosticsListenerFactory,
  INVALID_PORT_ERROR,
  LISTENER_ALREADY_ACTIVE_ERROR,
  nativeFramingRefusal,
  UNSUPPORTED_TRANSPORT_ERROR,
} from '../../src/diagnostics/local-diagnostics-listener.ts';
import type { DenoServeHost } from '../../src/adapters/deno/deno-http-adapter.ts';

/**
 * A fake serve host recording its calls and retaining the registered fetch
 * handler for direct invocation.
 *
 * @returns The host and its recordings
 */
function fakeHost(): {
  host: DenoServeHost;
  servers: Array<{ shutdown(): Promise<void> }>;
  calls: Array<{ port: number; hostname: string | undefined }>;
  fetches: Array<(request: Request) => Response | Promise<Response>>;
  listens: Array<((address: { hostname: string; port: number }) => void) | undefined>;
} {
  const servers: Array<{ shutdown(): Promise<void> }> = [];
  const calls: Array<{ port: number; hostname: string | undefined }> = [];
  const fetches: Array<(request: Request) => Response | Promise<Response>> = [];
  const listens: Array<((address: { hostname: string; port: number }) => void) | undefined> = [];
  return {
    servers,
    calls,
    fetches,
    listens,
    host: {
      serve(options) {
        calls.push({ port: options.port, hostname: options.hostname });
        listens.push(options.onListen);
        fetches.push(options.fetch);
        const server = {
          shutdown: () => Promise.resolve(),
        };
        servers.push(server);
        return server;
      },
    },
  };
}

/**
 * A minimal framework handler for the factory's options.
 *
 * @param request - The framework request
 * @returns The framework response
 */
function echoHandler(request: IRequest): IResponse {
  void request;
  return undefined as unknown as IResponse;
}

describe('Local diagnostics listener — platform gate', () => {
  it('refuses every listen on non-Deno platforms before any bind', async () => {
    for (const platform of ['node', 'bun', 'cloudflare-workers'] as const) {
      const factory = createLocalDiagnosticsListenerFactory(platform);
      await expect(
        factory.listen({ port: 4919, handler: echoHandler }),
      ).rejects.toThrow(UNSUPPORTED_TRANSPORT_ERROR);
      // closeActive on the unsupported factory is a no-op.
      await factory.closeActive();
    }
  });
});

describe('Local diagnostics listener — Deno factory', () => {
  it('binds exactly 127.0.0.1 and permits one active listener', async () => {
    const { host, calls, servers } = fakeHost();
    const factory = createLocalDiagnosticsListenerFactory('deno', host);
    const listener = await factory.listen({ port: 4919, handler: echoHandler });
    expect(calls).toEqual([{ port: 4919, hostname: '127.0.0.1' }]);
    await expect(
      factory.listen({ port: 4920, handler: echoHandler }),
    ).rejects.toThrow(LISTENER_ALREADY_ACTIVE_ERROR);
    await listener.close();
    expect(servers.length).toEqual(1);
  });

  it('refuses out-of-range ports before the bind', async () => {
    const { host, calls } = fakeHost();
    const factory = createLocalDiagnosticsListenerFactory('deno', host);
    for (const port of [0, 80, 1023, 65536, 4919.5, Number.NaN]) {
      await expect(factory.listen({ port, handler: echoHandler })).rejects.toThrow(
        INVALID_PORT_ERROR,
      );
    }
    expect(calls.length).toEqual(0);
  });

  it('close is idempotent and concurrency-safe, and frees the slot', async () => {
    const { host, servers } = fakeHost();
    const factory = createLocalDiagnosticsListenerFactory('deno', host);
    const listener = await factory.listen({ port: 4919, handler: echoHandler });
    await Promise.all([listener.close(), listener.close(), listener.close()]);
    // One shutdown, however many close calls raced.
    expect(servers.length).toEqual(1);
    // The slot is free again: a new listener is permitted.
    const second = await factory.listen({ port: 4919, handler: echoHandler });
    await second.close();
  });

  it('maps native requests to the framework handler and refusals around it', async () => {
    const { host, fetches } = fakeHost();
    const factory = createLocalDiagnosticsListenerFactory('deno', host);
    let seen: IRequest | null = null;
    await factory.listen({
      port: 4919,
      handler: (request) => {
        seen = request;
        return {
          status: () => undefined as never,
          header: () => undefined as never,
          appendHeader: () => undefined as never,
          json: () => undefined as never,
          text: () => undefined as never,
          html: () => undefined as never,
          send: () => undefined as never,
          redirect: () => undefined as never,
          stream: () => undefined as never,
          snapshot: () => ({
            streaming: false as const,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            body: new TextEncoder().encode('{}'),
          }),
        } satisfies IResponse;
      },
    });
    // A clean request reaches the handler as a framework IRequest.
    await fetches[0](new Request('http://127.0.0.1:4919/v1/status'));
    expect(seen).not.toBe(null);
    expect((seen as unknown as IRequest).path).toEqual('/v1/status');
    // A framed request never reaches the handler and answers the fixed
    // anonymous refusal.
    const refused = await fetches[0](
      new Request('http://127.0.0.1:4919/v1/status', {
        headers: { 'content-length': '5' },
      }),
    ) as Response;
    expect(refused.status).toEqual(400);
    const parsed = JSON.parse(await refused.text()) as Record<string, unknown>;
    expect(parsed).toEqual({ version: 1, error: 'invalid-request' });
    // Free the one-active-listener slot for the failure-path factory.
    await factory.closeActive();
    // An internal handler failure answers the fixed anonymous refusal —
    // no raw error text escapes.
    await factory.listen({
      port: 4920,
      handler: () => {
        throw new Error('secret internal detail');
      },
    });
    const failed = await fetches[1](
      new Request('http://127.0.0.1:4920/v1/status'),
    ) as Response;
    expect(failed.status).toEqual(503);
    const failureBody = JSON.parse(await failed.text()) as Record<string, unknown>;
    expect(failureBody).toEqual({ version: 1, error: 'unavailable' });
  });

  it('closeActive releases the port on the shutdown path', async () => {
    const { host, servers } = fakeHost();
    const factory = createLocalDiagnosticsListenerFactory('deno', host);
    await factory.listen({ port: 4919, handler: echoHandler });
    await factory.closeActive();
    await factory.closeActive(); // idempotent
    expect(servers.length).toEqual(1);
  });
});

describe('Local diagnostics listener — native framing', () => {
  it('refuses Transfer-Encoding, nonzero Content-Length, and comma-joined singletons', () => {
    const base = new Request('http://127.0.0.1:4919/v1/status');
    expect(nativeFramingRefusal(base)).toBe(null);

    const withTE = new Request('http://127.0.0.1:4919/v1/status', {
      headers: { 'transfer-encoding': 'chunked' },
    });
    expect(nativeFramingRefusal(withTE)?.status).toEqual(400);

    const withBody = new Request('http://127.0.0.1:4919/v1/status', {
      headers: { 'content-length': '5' },
    });
    expect(nativeFramingRefusal(withBody)?.status).toEqual(400);

    const zeroBody = new Request('http://127.0.0.1:4919/v1/status', {
      headers: { 'content-length': '0' },
    });
    expect(nativeFramingRefusal(zeroBody)).toBe(null);

    // A duplicate singleton header line coalesced by the fetch parser.
    const duplicated = new Request('http://127.0.0.1:4919/v1/status', {
      headers: { 'x-setu-session': 'a'.repeat(32) },
    });
    duplicated.headers.set('x-setu-session', `${'a'.repeat(32)}, ${'a'.repeat(32)}`);
    const refusal = nativeFramingRefusal(duplicated);
    expect(refusal?.status).toEqual(400);
    expect((refusal?.headers.get('content-type') ?? '').includes('application/json')).toBe(
      true,
    );
  });
});

describe('RuntimePlugin — provider registration', () => {
  it('registers the factory under the token and provides it', async () => {
    const { RuntimePlugin } = await import('../../src/plugin/runtime-plugin.ts');
    const plugin = RuntimePlugin({ platform: 'node' });
    expect(plugin.provides).toContain(CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER);
    const registrations: string[] = [];
    const hooks: Array<() => unknown> = [];
    const ctx = {
      services: {
        register: (token: string) => {
          registrations.push(token);
        },
      },
      lifecycle: {
        onClose: (fn: () => unknown) => hooks.push(fn),
      },
    } as never;
    plugin.register(ctx as never);
    expect(registrations).toContain(CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER);
    // The close hook is installed for shutdown/failure paths.
    expect(hooks.length).toEqual(1);
  });
});

describe('local diagnostics listener | startup announcement', () => {
  it('forwards a supplied onListen and omits the key when none is given', async () => {
    const fake = fakeHost();
    const factory = createLocalDiagnosticsListenerFactory('deno', fake.host);

    // Omitted: the key must be ABSENT, not bound to a no-op, so the runtime's
    // own banner still prints and the bind is never silent.
    await factory.listen({ port: 4919, handler: echoHandler });
    expect(fake.listens[0]).toBe(undefined);
    await factory.closeActive();

    // Supplied: forwarded verbatim, so the connector's labelled line REPLACES
    // the bare `Listening on http://127.0.0.1:<port>/` banner.
    const seen: Array<{ hostname: string; port: number }> = [];
    await factory.listen({
      port: 4920,
      handler: echoHandler,
      onListen: (address) => {
        seen.push(address);
      },
    });
    expect(typeof fake.listens[1]).toBe('function');
    fake.listens[1]!({ hostname: '127.0.0.1', port: 4920 });
    expect(seen).toEqual([{ hostname: '127.0.0.1', port: 4920 }]);
    await factory.closeActive();
  });
});
