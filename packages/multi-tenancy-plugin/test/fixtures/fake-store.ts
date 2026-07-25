/**
 * Recording fake ITenantDataStore for testing.
 */
import type { ITenantDataStore, ITenantIsolationStrategy } from '../../src/interfaces/index.ts';

export interface RecordingFakeStoreOptions {
  /** Tracks every method call for verification. */
  calls?: Array<{ method: string; args: unknown[] }>;
  /** Pre-populated data keyed by tenantId -> entity -> records */
  data?: Record<string, Record<string, Array<Record<string, unknown>>>>;
  /** Omits the optional `useIsolation` method. */
  omitUseIsolation?: boolean;
}

export function createRecordingFakeStore(
  opts?: RecordingFakeStoreOptions,
): ITenantDataStore & {
  calls: Array<{ method: string; args: unknown[] }>;
  isolationStrategy: ITenantIsolationStrategy | null;
} {
  const data = opts?.data ?? {};
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let isolationStrategy: ITenantIsolationStrategy | null = null;

  const base: Record<string, unknown> = {
    findAll<E>(_tenantId: string, _entity: string) {
      calls.push({ method: 'findAll', args: [_tenantId, _entity] });
      const entityData = (data[_tenantId]?.[_entity] ?? []) as E[];
      return Promise.resolve(entityData as readonly E[]);
    },
    findById<E, Id>(_tenantId: string, _entity: string, _id: Id) {
      // E is intentionally unused here — it's only for the return type cast below.
      void {} as E;
      calls.push({ method: 'findById', args: [_tenantId, _entity, _id] });
      const entities = data[_tenantId]?.[_entity] ?? [];
      const found = entities.find((e) => e.id === _id);
      return Promise.resolve(found ?? null);
    },
    find<E>(_tenantId: string, _entity: string, _filter: Record<string, unknown>) {
      calls.push({ method: 'find', args: [_tenantId, _entity, _filter] });
      const entities = data[_tenantId]?.[_entity] ?? [];
      const filtered = entities.filter((e) =>
        Object.entries(_filter).every(([k, v]) => e[k] === v)
      );
      return Promise.resolve(filtered as readonly E[]);
    },
    create<E>(_tenantId: string, _entity: string, record: Record<string, unknown>) {
      calls.push({ method: 'create', args: [_tenantId, _entity, record] });
      if (!data[_tenantId]) data[_tenantId] = {};
      if (!data[_tenantId][_entity]) data[_tenantId][_entity] = [];
      data[_tenantId][_entity].push({ ...record });
      return Promise.resolve(record as E);
    },
    update<E, Id>(_tenantId: string, _entity: string, _id: Id, record: Record<string, unknown>) {
      calls.push({ method: 'update', args: [_tenantId, _entity, _id, record] });
      const entities = data[_tenantId]?.[_entity] ?? [];
      const idx = entities.findIndex((e) => e.id === _id);
      if (idx === -1) return Promise.resolve(null);
      entities[idx] = { ...entities[idx], ...record };
      return Promise.resolve(entities[idx] as E);
    },
    delete<Id>(_tenantId: string, _entity: string, _id: Id) {
      calls.push({ method: 'delete', args: [_tenantId, _entity, _id] });
      const entities = data[_tenantId]?.[_entity] ?? [];
      const idx = entities.findIndex((e) => e.id === _id);
      if (idx === -1) return Promise.resolve(false);
      entities.splice(idx, 1);
      return Promise.resolve(true);
    },
    close() {
      calls.push({ method: 'close', args: [] });
      return Promise.resolve();
    },
  };

  interface StoreWithExtension extends ITenantDataStore {
    calls: typeof calls;
    isolationStrategy: typeof isolationStrategy;
    useIsolation?: (strategy: ITenantIsolationStrategy) => void;
  }

  const store = base as unknown as StoreWithExtension;

  if (!opts?.omitUseIsolation) {
    store.useIsolation = (strategy: ITenantIsolationStrategy) => {
      calls.push({ method: 'useIsolation', args: [strategy] });
      isolationStrategy = strategy;
    };
  }

  store.calls = calls;
  store.isolationStrategy = isolationStrategy;

  return store as ITenantDataStore & {
    calls: Array<{ method: string; args: unknown[] }>;
    isolationStrategy: ITenantIsolationStrategy | null;
  };
}
