/**
 * Runs the `IOutboxStore` contract suite (the custom-store contract the README
 * states) against the database bridge over a real memory `DatabaseService`.
 *
 * @module
 */
import { DatabaseOutboxStore } from '../../../src/outbox/database-outbox-store.ts';
import { describeOutboxStoreContract } from '../../fixtures/outbox-store-contract.ts';
import { ENTITY, memoryService } from '../../fixtures/outbox-store.ts';

describeOutboxStoreContract('database bridge over the memory adapter', async () => {
  const service = await memoryService();
  return {
    store: new DatabaseOutboxStore(service, ENTITY),
    inTransaction: (work) => service.transaction((uow) => work(uow)),
  };
});
