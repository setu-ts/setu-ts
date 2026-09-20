/**
 * Unit tests for the DiagnosticsPlugin factory: metadata and declared
 * dependency, explicit option validation, bootstrap activation over an
 * injected factory, generation-checked revocation (including a late-created
 * listener), and expiry.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type {
  ILocalDiagnosticsListener,
  ILocalDiagnosticsListenerFactory,
  IPluginContext,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import { DiagnosticsPlugin, PLUGIN_ERRORS } from '../../src/plugin/diagnostics-plugin.ts';
import { MutableClock, TEST_KEY_BYTES, TEST_SESSION_ID } from '../fixtures/helpers.ts';

/**
 * A fake listener recording closes.
 *
 * @internal
 */
function fakeListener(): ILocalDiagnosticsListener & { closeCount: number } {
  let closeCount = 0;
  let closePromise: Promise<void> | null = null;
  return {
    get closeCount(): number {
      return closeCount;
    },
    close(): Promise<void> {
      closePromise ??= Promise.resolve().then(() => {
        closeCount += 1;
      });
      return closePromise;
    },
  };
}

/**
 * Records one listen call.
 *
 * @internal
 */
interface ListenRecord {
  readonly port: number;
  readonly handlerPresent: boolean;
  readonly onListen?: ((address: { hostname: string; port: number }) => void) | undefined;
}

/**
 * Builds a fake plugin context with a recording lifecycle and a factory
 * that returns the given listener.
 *
 * @param listener - The listener the factory returns
 * @param diagnostics - The application's diagnostics facade
 * @param gate - Optional gate the factory awaits before answering listen
 * @param logger - Optional logger, as a context with LoggerPlugin registered has
 * @returns The context, the captured hooks, and the listen records
 */
function fakeContext(
  listener: ILocalDiagnosticsListener,
  diagnostics: unknown,
  gate?: Promise<void>,
  logger?: { info(message: string): void },
): {
  ctx: IPluginContext;
  hooks: Record<string, Array<() => unknown>>;
  listened: ListenRecord[];
} {
  const hooks: Record<string, Array<() => unknown>> = {
    bootstrap: [],
    stopping: [],
    close: [],
  };
  const listened: ListenRecord[] = [];
  const clock = new MutableClock();
  const factoryListener: ILocalDiagnosticsListenerFactory = {
    listen(options) {
      listened.push({
        port: options.port,
        handlerPresent: typeof options.handler === 'function',
        onListen: options.onListen,
      });
      if (gate === undefined) {
        return Promise.resolve(listener);
      }
      return gate.then(() => listener);
    },
  };
  return {
    hooks,
    listened,
    ctx: {
      services: {
        get(token: string) {
          if (token === CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER) {
            return factoryListener;
          }
          throw new Error(`not registered: ${token}`);
        },
      } as unknown as IPluginContext['services'],
      lifecycle: {
        onBootstrap: (fn: () => unknown) => hooks.bootstrap.push(fn),
        onStopping: (fn: () => unknown) => hooks.stopping.push(fn),
        onClose: (fn: () => unknown) => hooks.close.push(fn),
      } as unknown as IPluginContext['lifecycle'],
      runtime: {
        hrtime: () => clock.hrtime(),
        subtle: crypto.subtle,
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: (handle: unknown) => clearTimeout(handle as number),
      } as unknown as IPluginContext['runtime'],
      app: { diagnostics } as unknown as IPluginContext['app'],
      ...(logger === undefined ? {} : { logger }),
    } as unknown as IPluginContext,
  };
}

const OPTIONS = {
  enabled: true,
  port: 4919,
  sessionId: TEST_SESSION_ID,
  sessionKey: TEST_KEY_BYTES,
};

describe('Plugin — metadata and validation', () => {
  it('declares the connector dependency, provides nothing, and revokes', () => {
    const plugin: IDiagnosticsPluginLike = DiagnosticsPlugin(OPTIONS);
    expect(plugin.name).toEqual('diagnostics-plugin');
    expect(plugin.dependencies).toEqual([CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER]);
    expect(plugin.provides).toBeUndefined();
    expect(typeof plugin.revoke).toEqual('function');
    expect(plugin.revoke()).toBeInstanceOf(Promise);
  });

  it('refuses every invalid option at composition with fixed errors', () => {
    expect(() => DiagnosticsPlugin({ ...OPTIONS, enabled: false })).toThrow(
      PLUGIN_ERRORS.notEnabled,
    );
    expect(() => DiagnosticsPlugin({ ...OPTIONS, port: 80 })).toThrow(PLUGIN_ERRORS.invalidPort);
    expect(() => DiagnosticsPlugin({ ...OPTIONS, port: 65536 })).toThrow(
      PLUGIN_ERRORS.invalidPort,
    );
    expect(() => DiagnosticsPlugin({ ...OPTIONS, port: 4919.5 })).toThrow(
      PLUGIN_ERRORS.invalidPort,
    );
    expect(() => DiagnosticsPlugin({ ...OPTIONS, sessionId: 'short' })).toThrow(
      PLUGIN_ERRORS.invalidSessionId,
    );
    expect(() => DiagnosticsPlugin({ ...OPTIONS, sessionKey: new Uint8Array(8) })).toThrow(
      PLUGIN_ERRORS.invalidSessionKey,
    );
    expect(() => DiagnosticsPlugin({ ...OPTIONS, ttlMs: 0 })).toThrow(PLUGIN_ERRORS.invalidTtl);
    expect(() => DiagnosticsPlugin({ ...OPTIONS, ttlMs: 3_600_001 })).toThrow(
      PLUGIN_ERRORS.invalidTtl,
    );
  });

  it('refuses registration when kernel diagnostics were not enabled', () => {
    const plugin = DiagnosticsPlugin(OPTIONS);
    const { ctx } = fakeContext(fakeListener(), undefined);
    expect(() => plugin.register(ctx)).toThrow(PLUGIN_ERRORS.missingDiagnostics);
  });
});

/** Local structural type avoiding an import cycle in the test. */
interface IDiagnosticsPluginLike {
  readonly name: string;
  readonly dependencies?: readonly string[];
  readonly provides?: readonly string[];
  register(ctx: IPluginContext): void;
  revoke(): Promise<void>;
}

describe('Plugin — activation', () => {
  it('opens the listener in onBootstrap with the explicit port', async () => {
    const listener = fakeListener();
    const plugin = DiagnosticsPlugin(OPTIONS);
    const { ctx, hooks, listened } = fakeContext(listener, { snapshot: () => undefined });
    plugin.register(ctx);
    // Cleanup hooks installed during register, BEFORE the listener opens.
    expect(hooks.stopping.length).toEqual(1);
    expect(hooks.close.length).toEqual(1);
    expect(hooks.bootstrap.length).toEqual(1);
    await hooks.bootstrap[0]();
    expect(listened).toEqual([{ port: 4919, handlerPresent: true }]);
    // Not closed yet: the session is live.
    expect(listener.closeCount).toEqual(0);
    await plugin.revoke();
    expect(listener.closeCount).toEqual(1);
  });

  it('installs stopping and close hooks before opening the listener', async () => {
    const plugin = DiagnosticsPlugin(OPTIONS);
    const { ctx, hooks } = fakeContext(fakeListener(), { snapshot: () => undefined });
    plugin.register(ctx);
    // Hook installation order is register-time; the listener opens only
    // when bootstrap runs. Both revocation hooks exist before that.
    expect(hooks.stopping.length).toEqual(1);
    expect(hooks.close.length).toEqual(1);
    await plugin.revoke();
    // Invoking the hooks after revoke is safe: idempotent cleanup.
    await hooks.stopping[0]();
    await hooks.close[0]();
  });

  it('closes a late-created listener when revoke lands during activation', async () => {
    // A holder object defeats TS's control-flow narrowing: the closure
    // below assigns the resolver, which the analysis cannot see.
    const gateHandle: { release: (() => void) | null } = { release: null };
    const gate = new Promise<void>((resolve) => {
      gateHandle.release = resolve;
    });
    const plugin = DiagnosticsPlugin(OPTIONS);
    const listener = fakeListener();
    const { ctx, hooks, listened } = fakeContext(listener, { snapshot: () => undefined }, gate);
    plugin.register(ctx);
    const bootstrap = hooks.bootstrap[0]() as Promise<void>;
    // Let session creation finish and listen() enter its gate.
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Revoke DURING the gated bind.
    const revocation = plugin.revoke();
    gateHandle.release?.();
    await Promise.all([bootstrap, revocation]);
    // The listener WAS created (the bind was in flight)...
    expect(listened.length).toEqual(1);
    // ...and the generation check closed the late-created listener.
    expect(listener.closeCount).toEqual(1);
  });

  it('expires the session at the configured TTL', async () => {
    const listener = fakeListener();
    const plugin = DiagnosticsPlugin({ ...OPTIONS, ttlMs: 50 });
    const { ctx, hooks } = fakeContext(listener, { snapshot: () => undefined });
    plugin.register(ctx);
    await hooks.bootstrap[0]();
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The expiry timer revoked the connector, closing the listener.
    expect(listener.closeCount).toEqual(1);
    // A second revoke awaits the same cleanup and is safe.
    await plugin.revoke();
    expect(listener.closeCount).toEqual(1);
  });

  it('does not reopen after revocation and never reactivates', async () => {
    const listener = fakeListener();
    const plugin = DiagnosticsPlugin(OPTIONS);
    const { ctx, hooks, listened } = fakeContext(listener, { snapshot: () => undefined });
    plugin.register(ctx);
    await plugin.revoke();
    // A bootstrap that arrives after revocation opens nothing.
    await hooks.bootstrap[0]();
    expect(listened.length).toEqual(0);
    expect(listener.closeCount).toEqual(0);
  });
});

describe('Plugin — expiry close failure', () => {
  it('does not surface an unhandled rejection when the expiry close fails', async () => {
    const unhandled: unknown[] = [];
    const handler = (event: PromiseRejectionEvent): void => {
      unhandled.push(event.reason);
    };
    globalThis.addEventListener('unhandledrejection', handler);

    let closeCalls = 0;
    const rejectingListener: ILocalDiagnosticsListener = {
      close: () => {
        closeCalls += 1;
        return Promise.reject(new Error('shutdown exploded'));
      },
    };
    const plugin = DiagnosticsPlugin({ ...OPTIONS, ttlMs: 30 });
    const { ctx, hooks } = fakeContext(rejectingListener, { snapshot: () => undefined });
    plugin.register(ctx);
    await hooks.bootstrap[0]();
    // The expiry timer fires revoke(); close() rejects. The timer must
    // swallow the failure: an unhandled rejection terminates the process.
    await new Promise((resolve) => setTimeout(resolve, 150));
    globalThis.removeEventListener('unhandledrejection', handler);
    expect(closeCalls).toEqual(1);
    expect(unhandled).toEqual([]);
    // A direct caller still observes the rejection (same memoized promise).
    await expect(plugin.revoke()).rejects.toThrow(/shutdown exploded/);
  });
});

describe('DiagnosticsPlugin — startup announcement', () => {
  it('labels its own listening line when a logger is registered, and omits it otherwise', async () => {
    const listener = { close: () => Promise.resolve() };

    // No logger: the key must be ABSENT, so the runtime's own banner stands
    // and a bind is never silent. Binding a no-op here would lose the signal.
    const bare = fakeContext(listener, { snapshot: () => undefined });
    DiagnosticsPlugin(OPTIONS).register!(bare.ctx);
    await bare.hooks.bootstrap[0]!();
    expect(bare.listened[0].onListen).toBe(undefined);

    // With a logger: a labelled line that names the devtool, through the
    // application's own logger rather than a raw write.
    const lines: string[] = [];
    const logged = fakeContext(
      listener,
      { snapshot: () => undefined },
      undefined,
      { info: (message: string) => lines.push(message) },
    );
    DiagnosticsPlugin(OPTIONS).register!(logged.ctx);
    await logged.hooks.bootstrap[0]!();
    const announce = logged.listened[0].onListen;
    expect(typeof announce).toBe('function');
    announce!({ hostname: '127.0.0.1', port: 4919 });
    expect(lines).toEqual([
      'Setu devtool: local diagnostics connector listening on http://127.0.0.1:4919',
    ]);
  });
});
