/**
 * A fake LaunchDarkly SDK, honoring the real client's actual contract.
 *
 * The shapes here are taken from the SDK's shipped type definitions, not from
 * memory: `init` is SYNCHRONOUS and returns immediately, `initialized()` is
 * synchronous, `waitForInitialization`/`boolVariation`/`allFlagsState` are all
 * asynchronous, `LDFlagsState.getFlagValue` is synchronous and returns `null`
 * for an unknown flag, and `close()` is synchronous. A fake that got any of
 * those wrong would let a broken bridge pass.
 *
 * @module
 */

import type {
  ILaunchDarklyClient,
  ILaunchDarklyFlagsState,
  ILaunchDarklyModule,
  LaunchDarklyContext,
} from '../../src/providers/launchdarkly-module.ts';

/** A recorded `boolVariation` call. */
export interface RecordedVariation {
  readonly key: string;
  readonly contextKey: string;
  readonly defaultValue: boolean;
}

/** Options controlling the fake client's behavior. */
export interface FakeClientOptions {
  /** Flag values per context key; `'*'` applies to every context. */
  readonly values?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Make `waitForInitialization` reject, simulating an unreachable backend. */
  readonly failInitialization?: boolean;
  /** Report `initialized()` as false. */
  readonly neverInitializes?: boolean;
  /** Make `allFlagsState` reject. */
  readonly failSnapshot?: boolean;
  /** Return a snapshot whose `valid` is false. */
  readonly invalidSnapshot?: boolean;
}

/** A controllable stand-in for LaunchDarkly's `LDClient`. */
export class FakeLaunchDarklyClient implements ILaunchDarklyClient {
  readonly #options: FakeClientOptions;
  /** Every `boolVariation` call, in order. */
  readonly variations: RecordedVariation[] = [];
  /** Every context key `allFlagsState` was called with, in order. */
  readonly snapshotCalls: string[] = [];
  /** Registered `update` listeners. */
  readonly #listeners: Array<() => void> = [];
  /** Number of times `close()` was called. */
  closeCount = 0;

  constructor(options: FakeClientOptions = {}) {
    this.#options = options;
  }

  initialized(): boolean {
    return this.#options.neverInitializes !== true;
  }

  waitForInitialization(_options?: { readonly timeoutSeconds?: number }): Promise<unknown> {
    if (this.#options.failInitialization === true) {
      return Promise.reject(new Error('LaunchDarkly client initialization timed out'));
    }
    return Promise.resolve(this);
  }

  boolVariation(
    key: string,
    context: LaunchDarklyContext,
    defaultValue: boolean,
  ): Promise<boolean> {
    this.variations.push({ key, contextKey: context.key, defaultValue });
    const value = this.#valueFor(context.key, key);
    return Promise.resolve(typeof value === 'boolean' ? value : defaultValue);
  }

  allFlagsState(context: LaunchDarklyContext): Promise<ILaunchDarklyFlagsState> {
    this.snapshotCalls.push(context.key);
    if (this.#options.failSnapshot === true) {
      return Promise.reject(new Error('snapshot unavailable'));
    }
    const contextKey = context.key;
    const state: ILaunchDarklyFlagsState = {
      valid: this.#options.invalidSnapshot !== true,
      // Synchronous, exactly as the real LDFlagsState is — this is the property
      // the whole sync bridge depends on.
      getFlagValue: (flagKey: string): unknown => this.#valueFor(contextKey, flagKey) ?? null,
    };
    return Promise.resolve(state);
  }

  on(event: string, listener: () => void): void {
    if (event === 'update') {
      this.#listeners.push(listener);
    }
  }

  close(): void {
    this.closeCount++;
  }

  /** Fires the SDK's `update` event, as a flag change would. */
  emitUpdate(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }

  #valueFor(contextKey: string, flagKey: string): unknown {
    const values = this.#options.values ?? {};
    const perContext = values[contextKey];
    if (perContext !== undefined && flagKey in perContext) {
      return perContext[flagKey];
    }
    const wildcard = values['*'];
    if (wildcard !== undefined && flagKey in wildcard) {
      return wildcard[flagKey];
    }
    return undefined;
  }
}

/** A stand-in for the SDK module surface, recording the key it was built with. */
export class FakeLaunchDarklyModule implements ILaunchDarklyModule {
  readonly #client: FakeLaunchDarklyClient;
  /** Every `init` call, in order. */
  readonly initCalls: Array<{ sdkKey: string; options?: Readonly<Record<string, unknown>> }> = [];

  constructor(client: FakeLaunchDarklyClient) {
    this.#client = client;
  }

  init(sdkKey: string, options?: Readonly<Record<string, unknown>>): ILaunchDarklyClient {
    // Recorded as a pair so a test can assert `ldOptions` was forwarded
    // verbatim; `options` is omitted rather than set to undefined because
    // exactOptionalPropertyTypes is on.
    this.initCalls.push(options === undefined ? { sdkKey } : { sdkKey, options });
    return this.#client;
  }
}
