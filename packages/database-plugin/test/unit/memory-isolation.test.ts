import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import { UnsupportedIsolationLevelError } from '../../src/errors.ts';

describe('MemoryAdapter transaction isolation', () => {
  it('preserves the default lost-update behaviour when isolation is omitted', async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    const source = adapter.createDataSource('Counter');
    await source.create({ id: 'counter', value: 100 });

    let release: (() => void) | undefined;
    const readTogether = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const decrement = async (): Promise<void> => {
      const tx = await adapter.beginTransaction();
      const txSource = tx.createDataSource('Counter');
      const current = await txSource.findById('counter');
      reads++;
      if (reads === 2) release?.();
      await readTogether;
      await txSource.update('counter', { value: Number(current?.value) - 10 });
      await tx.commit();
    };

    await Promise.all([decrement(), decrement()]);
    await expect(source.findById('counter')).resolves.toMatchObject({ value: 90 });
  });

  it('serializes read-modify-write transactions when serializable is requested', async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    const source = adapter.createDataSource('Counter');
    await source.create({ id: 'counter', value: 100 });

    const decrement = async (): Promise<void> => {
      const tx = await adapter.beginTransaction({ isolation: 'serializable' });
      const txSource = tx.createDataSource('Counter');
      const current = await txSource.findById('counter');
      await txSource.update('counter', { value: Number(current?.value) - 10 });
      await tx.commit();
    };

    await Promise.all([decrement(), decrement()]);
    await expect(source.findById('counter')).resolves.toMatchObject({ value: 80 });
  });

  it('refuses levels the memory adapter cannot honour', async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();

    await expect(adapter.beginTransaction({ isolation: 'read-committed' }))
      .rejects.toBeInstanceOf(UnsupportedIsolationLevelError);
  });
});
