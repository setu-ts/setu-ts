/**
 * The `IInboxStore` contract (M108 §3.10) against the shipped bridge over the
 * memory adapter. The same suite runs against real PostgreSQL from
 * `messaging-plugin`'s real-backend tests.
 *
 * @module
 */
import { describeInboxStoreContract } from '../../fixtures/inbox-store-contract.ts';
import { memoryService, storeOver } from '../../fixtures/inbox-store.ts';

describeInboxStoreContract('database bridge over memory', async () => ({
  store: storeOver(await memoryService()),
}));
