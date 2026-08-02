/**
 * Unit tests for the static provider.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { StaticProvider } from '../../src/providers/static-provider.ts';
import type { DiscoveryProvider } from '../../src/interfaces/index.ts';
import { createFakeRuntime } from '../fixtures/fakes.ts';

describe('StaticProvider', () => {
  it('stamps serviceName and synthesizes an id when none is given', async () => {
    const provider = new StaticProvider(
      { billing: [{ host: '10.0.0.1', port: 8080 }] },
      createFakeRuntime(),
    );
    expect(await provider.resolve('billing')).toEqual([
      { id: '10.0.0.1:8080', serviceName: 'billing', host: '10.0.0.1', port: 8080 },
    ]);
  });

  it('a supplied id wins over the synthesized one', async () => {
    const provider = new StaticProvider(
      { billing: [{ id: 'billing-1', host: '10.0.0.1', port: 8080 }] },
      createFakeRuntime(),
    );
    const [only] = await provider.resolve('billing');
    expect(only.id).toBe('billing-1');
  });

  it('carries secure, weight, tags, and metadata through', async () => {
    const provider = new StaticProvider(
      {
        billing: [{
          host: 'svc',
          port: 443,
          secure: true,
          weight: 5,
          tags: ['primary'],
          metadata: { zone: 'eu-1' },
        }],
      },
      createFakeRuntime(),
    );
    expect(await provider.resolve('billing')).toEqual([
      {
        id: 'svc:443',
        serviceName: 'billing',
        host: 'svc',
        port: 443,
        secure: true,
        weight: 5,
        tags: ['primary'],
        metadata: { zone: 'eu-1' },
      },
    ]);
  });

  it('omits optional keys entirely rather than setting them undefined', async () => {
    const provider = new StaticProvider(
      { billing: [{ host: '10.0.0.1', port: 8080 }] },
      createFakeRuntime(),
    );
    const [only] = await provider.resolve('billing');
    expect('secure' in only).toBe(false);
    expect('weight' in only).toBe(false);
    expect('tags' in only).toBe(false);
    expect('metadata' in only).toBe(false);
  });

  it('resolves an unknown service to an empty list rather than throwing', async () => {
    const provider = new StaticProvider({}, createFakeRuntime());
    expect(await provider.resolve('nope')).toEqual([]);
  });

  it('reports the backend id', () => {
    expect(new StaticProvider({}, createFakeRuntime()).kind).toBe('static');
  });

  it('has no registerSelf — the list has nothing to register with', () => {
    // Typed as the port, because that is how the plugin probes for the
    // capability before deciding whether selfRegistration is honourable.
    const provider: DiscoveryProvider = new StaticProvider({}, createFakeRuntime());
    expect(provider.registerSelf).toBeUndefined();
    expect(provider.deregisterSelf).toBeUndefined();
  });

  it('watch fires once with the configured list and never again', async () => {
    const runtime = createFakeRuntime();
    const provider = new StaticProvider(
      { billing: [{ host: '10.0.0.1', port: 8080 }] },
      runtime,
    );
    const seen: number[] = [];
    await provider.watch('billing', (list) => seen.push(list.length));

    expect(seen).toEqual([]);
    runtime.runTimeouts();
    expect(seen).toEqual([1]);

    // No interval was armed, so there is nothing left that could fire again.
    expect(runtime.intervals).toHaveLength(0);
  });

  it('unsubscribing before the timer fires suppresses the delivery', async () => {
    const runtime = createFakeRuntime();
    const provider = new StaticProvider(
      { billing: [{ host: '10.0.0.1', port: 8080 }] },
      runtime,
    );
    const seen: number[] = [];
    const unsubscribe = await provider.watch('billing', (list) => seen.push(list.length));

    unsubscribe();
    runtime.runTimeouts();
    expect(seen).toEqual([]);
  });
});
