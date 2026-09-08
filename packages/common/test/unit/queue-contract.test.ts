/**
 * Compile-time contract tests for the M90i queue header channel (X34-1).
 *
 * These assertions are decided by `deno task check`: if `IJob.headers` or
 * `AddJobOptions.headers` becomes required, changes shape, or loses its
 * `readonly`, this file stops compiling. Runtime expectations are asserted
 * alongside so it also fails loudly under `deno task test`.
 *
 * The point of the file is the OPTIONALITY. A required member would break every
 * out-of-repo `IQueue` implementor with no deprecation path, and it would also
 * destroy the three-state distinction the channel is worth having for: absent
 * means "this queue has no channel", `{}` means "the channel was read and was
 * empty".
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  AddJobOptions,
  IJob,
  IQueue,
  JobProcessor,
  ProcessOptions,
  RecurringOptions,
} from '../../src/services/queue.ts';
import type { MessageMetadata } from '../../src/services/messaging.ts';

/** Strict identity check — fails on any added, removed, or re-typed member. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true
  : false;

/** Compile-time assertion helper. */
function assertType<T extends true>(_value?: T): void {}

// The channel is spelled IDENTICALLY on both ingresses, so the two cannot drift
// on meaning — which is the whole reason X34-1 asks for a mirror of
// `MessageMetadata.headers` rather than a new shape.
assertType<Equals<IJob['headers'], MessageMetadata['headers']>>();
assertType<Equals<AddJobOptions['headers'], MessageMetadata['headers']>>();

// Both are OPTIONAL and READONLY.
assertType<Equals<IJob['headers'], Readonly<Record<string, string>> | undefined>>();
assertType<Equals<AddJobOptions['headers'], Readonly<Record<string, string>> | undefined>>();

// An implementation predating the channel still satisfies the contract: no
// member became required (the M42 `signal?` / M44 `fs?` precedent).
const preM90iQueue: IQueue = {
  add<T>(_name: string, _data: T, _options?: AddJobOptions): Promise<string> {
    return Promise.resolve('id');
  },
  process<T>(_n: string, _p: JobProcessor<T>, _o?: ProcessOptions): void {},
  addRecurring<T>(_n: string, _d: T, _o: RecurringOptions): Promise<void> {
    return Promise.resolve();
  },
};

// A job built without the member is a valid `IJob` …
const withoutChannel: IJob<{ id: number }> = {
  id: 'j-1',
  name: 'orders',
  data: { id: 1 },
  attempts: 1,
};

// … and so is one carrying it.
const withChannel: IJob<{ id: number }> = {
  id: 'j-1',
  name: 'orders',
  data: { id: 1 },
  attempts: 1,
  headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
};

describe('IJob / AddJobOptions header channel', () => {
  it('is optional on both types', () => {
    expect(withoutChannel.headers).toBeUndefined();
    expect('headers' in withoutChannel).toBe(false);
    expect(withChannel.headers?.traceparent).toBeDefined();
  });

  it('keeps a pre-M90i IQueue implementation valid', async () => {
    expect(await preM90iQueue.add('orders', {})).toBe('id');
  });

  it('accepts headers on AddJobOptions beside the existing members', () => {
    const options: AddJobOptions = {
      delayMs: 10,
      maxAttempts: 3,
      headers: { traceparent: 'tp' },
    };
    expect(options.headers).toEqual({ traceparent: 'tp' });
  });

  it('distinguishes an empty channel from no channel', () => {
    const empty: IJob = { id: 'j', name: 'n', data: null, attempts: 1, headers: {} };
    // `=== undefined` is satisfied by BOTH; only a presence test separates them.
    expect('headers' in empty).toBe(true);
    expect('headers' in withoutChannel).toBe(false);
  });
});
