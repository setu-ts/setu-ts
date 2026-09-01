/**
 * Unit tests for partition-key discovery, caching and the mismatch refusal.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  PartitionKeyResolver,
  renderPaths,
  samePaths,
} from '../../src/adapters/cosmos/cosmos-partition-key.ts';
import { resolveCosmosTarget } from '../../src/adapters/cosmos/cosmos-mapping.ts';
import { createFakeCosmosClient } from '../fixtures/fake-cosmos-client.ts';

describe('samePaths', () => {
  it('compares path lists element-wise, including order', () => {
    expect(samePaths([['a']], [['a']])).toBe(true);
    expect(samePaths([['a'], ['b']], [['b'], ['a']])).toBe(false);
    expect(samePaths([['a']], [['a'], ['b']])).toBe(false);
    expect(samePaths([['a', 'b']], [['a', 'c']])).toBe(false);
    expect(samePaths([['a', 'b']], [['a']])).toBe(false);
  });
});

describe('renderPaths', () => {
  it('renders a hierarchical key the way a container definition spells it', () => {
    expect(renderPaths([['t'], ['r']])).toBe('/t, /r');
  });
});

describe('PartitionKeyResolver', () => {
  it('discovers the paths from the container definition', async () => {
    const fake = createFakeCosmosClient({
      containers: { orders: { partitionKeyPaths: ['/tenantId'] } },
    });
    const resolver = new PartitionKeyResolver(fake.client.database('db'));
    const resolved = await resolver.resolve(resolveCosmosTarget('orders', undefined));
    expect(resolved.paths).toEqual([['tenantId']]);
  });

  it('reads a container definition ONCE however many times it is resolved', async () => {
    const fake = createFakeCosmosClient({
      containers: { orders: { partitionKeyPaths: ['/tenantId'] } },
    });
    const resolver = new PartitionKeyResolver(fake.client.database('db'));
    const target = resolveCosmosTarget('orders', undefined);
    await Promise.all([resolver.resolve(target), resolver.resolve(target)]);
    await resolver.resolve(target);
    expect(fake.recorder.definitionReads['orders']).toBe(1);
  });

  it('accepts a configured key that agrees with the container', async () => {
    const fake = createFakeCosmosClient({
      containers: { orders: { partitionKeyPaths: ['/address/city'] } },
    });
    const resolver = new PartitionKeyResolver(fake.client.database('db'));
    const target = resolveCosmosTarget('Order', {
      Order: { container: 'orders', partitionKey: ['address', 'city'] },
    });
    expect((await resolver.resolve(target)).paths).toEqual([['address', 'city']]);
  });

  it('refuses a configured key the container disagrees with, naming both', async () => {
    const fake = createFakeCosmosClient({
      containers: { orders: { partitionKeyPaths: ['/tenantId'] } },
    });
    const resolver = new PartitionKeyResolver(fake.client.database('db'));
    const target = resolveCosmosTarget('Order', {
      Order: { container: 'orders', partitionKey: 'accountId' },
    });
    await expect(resolver.resolve(target)).rejects.toThrow(
      /partition-key mismatch on container 'orders': the mapping declares \/accountId but the container declares \/tenantId/,
    );
  });

  it('names a container that does not exist', async () => {
    const fake = createFakeCosmosClient({ containers: {} });
    const resolver = new PartitionKeyResolver(fake.client.database('db'));
    await expect(resolver.resolve(resolveCosmosTarget('ghost', undefined)))
      .rejects.toThrow(
        /could not read container 'ghost'.*must exist before the application starts/s,
      );
  });

  it('reports a container definition carrying no partition key', async () => {
    const fake = createFakeCosmosClient({ containers: { odd: { partitionKeyPaths: [] } } });
    const resolver = new PartitionKeyResolver(fake.client.database('db'));
    await expect(resolver.resolve(resolveCosmosTarget('odd', undefined)))
      .rejects.toThrow(/no partition-key definition on container 'odd'/);
  });

  it('renders a non-Error rejection from the definition read', async () => {
    const resolver = new PartitionKeyResolver({
      read: () => Promise.resolve({ statusCode: 200 }),
      container: () => ({
        items: {} as never,
        item: () => ({}) as never,
        read: () => Promise.reject('a bare string, not an Error'),
      }),
    });
    await expect(resolver.resolve(resolveCosmosTarget('odd', undefined)))
      .rejects.toThrow(/a bare string, not an Error/);
  });

  it('does NOT cache a failure, so a container created later resolves', async () => {
    const containers: Record<string, { partitionKeyPaths?: readonly string[] }> = {};
    const fake = createFakeCosmosClient({ containers });
    const resolver = new PartitionKeyResolver(fake.client.database('db'));
    const target = resolveCosmosTarget('late', undefined);
    await expect(resolver.resolve(target)).rejects.toThrow(/could not read container/);
    containers['late'] = { partitionKeyPaths: ['/pk'] };
    expect((await resolver.resolve(target)).paths).toEqual([['pk']]);
  });
});
