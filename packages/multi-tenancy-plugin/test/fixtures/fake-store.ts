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
    findAll<E>(tenantId: string, entity: string) {
      calls.push(['findAll', [tenantId, entity]]);
      const entityData = (data[tenantId]?.[entity] ?? []) as E[];
      return Promise.resolve(entityData as readonly E[]);
    },
    findById<E, Id>(tenantId: string, entity: string, id: Id) {
      calls.push(['findById', [tenantId, entity, id]]);
      const entities = data[tenantId]?.[entity] ?? [];
      const found = entities.find((e) => e.id === id);
      return Promise.resolve(found ?? null);
    },
    find<E>(tenantId: string, entity: string, filter: Record<string, unknown>) {
      calls.push(['find', [tenantId, entity, filter]]);
      const entities = data[tenantId]?.[entity] ?? [];
      const filtered = entities.filter((e) => Object.entries(filter).every(([k, v]) => e[k] === v));
      return Promise.resolve(filtered as readonly E[]);
    },
    create<E>(tenantId: string, entity: string, record: Record<string, unknown>) {
      calls.push(['create', [tenantId, entity, record]]);
      if (!data[tenantId]) data[tenantId] = {};
      if (!data[tenantId][entity]) data[tenantId][entity] = [];
      data[tenantId][entity].push({ ...record });
      return Promise.resolve(record as E);
    },
    update<E, Id>(tenantId: string, entity: string, id: Id, record: Record<string, unknown>) {
      calls.push(['update', [tenantId, entity, id, record]]);
      const entities = data[tenantId]?.[entity] ?? [];
      const idx = entities.findIndex((e) => e.id === id);
      if (idx === -1) return Promise.resolve(null);
      entities[idx] = { ...entities[idx], ...record };
      return Promise.resolve(entities[idx] as E);
    },
    delete<Id>(tenantId: string, entity: string, id: Id) {
      calls.push(['delete', [tenantId, entity, id]]);
      const entities = data[tenantId]?.[entity] ?? [];
      const idx = entities.findIndex((e) => e.id === id);
      if (idx === -1) return Promise.resolve(false);
      entities.splice(idx, 1);
      return Promise.resolve(true);
    },
    close() {
      calls.push(['close', []]);
      return Promise.resolve();
    },
  };

  const store = base as unknown as ITenantDataStore & {
    calls: typeof calls;
    isolationStrategy: typeof isolationStrategy;
  };

  if (!opts?.omitUseIsolation) {
    (store as any).useIsolation = (strategy: ITenantIsolationStrategy) => {
      calls.push(['useIsolation', [strategy]]);
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
