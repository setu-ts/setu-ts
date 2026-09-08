/**
 * Contract tests for the explicit Drizzle isolation bridge declaration.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  createDrizzleDatabase,
  DrizzleAdapter,
  type DrizzleTransactionBridge,
  UnsupportedIsolationLevelError,
  withIsolationSupport,
} from '../../src/index.ts';
import {
  createFakeDrizzleInstance,
  createFakeDrizzleTable,
} from '../fixtures/fake-drizzle-instance.ts';

describe('Drizzle isolation bridge', () => {
  it('forwards options to an explicitly branded bridge', async () => {
    const database = createFakeDrizzleInstance();
    let received: import('@setu-ts/common').TransactionOptions | undefined;
    const bridge = withIsolationSupport<typeof database>((outer, work, options) => {
      received = options;
      return outer.transaction(work);
    });
    const adapter = new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(database, bridge),
      drizzleTables: { user: createFakeDrizzleTable('user') },
    });
    await adapter.connect();

    const transaction = await adapter.beginTransaction({ isolation: 'serializable' });
    expect(received).toEqual({ isolation: 'serializable' });
    await transaction.commit();
  });

  it('refuses isolation for an unbranded bridge before opening native work', async () => {
    const database = createFakeDrizzleInstance();
    let opened = false;
    const bridge = async <T>(
      outer: typeof database,
      work: (transaction: typeof database) => Promise<T>,
    ): Promise<T> => {
      opened = true;
      return await outer.transaction(work);
    };
    const adapter = new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(database, bridge),
      drizzleTables: { user: createFakeDrizzleTable('user') },
    });
    await adapter.connect();

    await expect(adapter.beginTransaction({ isolation: 'read-committed' }))
      .rejects.toBeInstanceOf(UnsupportedIsolationLevelError);
    expect(opened).toBe(false);
  });

  it('keeps two-parameter application bridges source-compatible', () => {
    const database = createFakeDrizzleInstance();
    const bridge: DrizzleTransactionBridge<typeof database> = (outer, work) =>
      outer.transaction(work);

    expect(typeof bridge).toBe('function');
  });
});
