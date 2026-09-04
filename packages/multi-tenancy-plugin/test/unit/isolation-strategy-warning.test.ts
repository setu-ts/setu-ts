/**
 * X18-5: a non-`column` isolation strategy NAMES isolation only a store whose
 * backend implements it can deliver. With the default memory store and no
 * injected `dataStore`, that composition cannot honour the selection, so
 * `register()` warns — conditioned on the PAIRING (non-`column` strategy AND
 * no `dataStore`), never on the strategy alone, so a deliberate custom store
 * stays silent.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger, IPluginContext } from '@setu-ts/common';

import { MultiTenancyPlugin } from '../../src/plugin/multi-tenancy-plugin.ts';
import { attachRecordingLogger, createRecordingFakeLogger } from '../fixtures/fake-logger.ts';
import { createRecordingFakeStore } from '../fixtures/fake-store.ts';
import type { ITenantDataStore } from '../../src/interfaces/index.ts';

/** Minimal plugin context: recording logger, JWT registered, recorded registrations. */
function makeContext(): { ctx: IPluginContext; warnCalls: string[] } {
  const recording = createRecordingFakeLogger();
  const logger: ILogger = attachRecordingLogger(recording);
  const ctx = {
    services: {
      has: (token: string) => token === CAPABILITIES.JWT,
      get: () => ({
        decode: () => ({ tenant_id: 't1' }),
      }),
      register: () => {},
      registerFactory: () => {},
      getAll: () => [],
      unregister: () => false,
    },
    middleware: { add: () => {} },
    health: { register: () => {} },
    lifecycle: { onClose: () => {} },
    logger,
    runtime: { uuid: () => 'uuid-1' },
  } as unknown as IPluginContext;
  return { ctx, warnCalls: recording.warnCalls };
}

function warnsFor(options: Parameters<typeof MultiTenancyPlugin>[0]): string[] {
  const { ctx, warnCalls } = makeContext();
  MultiTenancyPlugin(options).register(ctx);
  return warnCalls;
}

describe('isolation strategy warning (X18-5)', () => {
  it("warns for 'schema-per-tenant' with no dataStore, naming the option spelling", () => {
    const warns = warnsFor({ resolver: 'header', database: 'schema-per-tenant' });
    expect(warns).toHaveLength(1);
    // The warning names the OPTION spelling written in MultiTenancyPluginOptions
    // ('schema-per-tenant'), not the resolved strategy kind ('schema'), so it
    // maps back to the option the developer set.
    expect(warns[0]).toContain("'schema-per-tenant'");
    expect(warns[0]).toContain('dataStore');
  });

  it("warns for 'database-per-tenant' with no dataStore", () => {
    const warns = warnsFor({ resolver: 'header', database: 'database-per-tenant' });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("'database-per-tenant'");
  });

  it('warns for a custom non-column strategy object with no dataStore', () => {
    // The resolved strategy kind decides — a custom object with kind 'schema'
    // is the same unimplementable pairing.
    const warns = warnsFor({
      resolver: 'header',
      database: { kind: 'schema', resolveSchema: (tenantId: string) => `s_${tenantId}` },
    });
    expect(warns).toHaveLength(1);
  });

  it('is silent with a dataStore supplied', () => {
    const store: ITenantDataStore = createRecordingFakeStore() as unknown as ITenantDataStore;
    const warns = warnsFor({
      resolver: 'header',
      database: 'schema-per-tenant',
      dataStore: store,
    });
    expect(warns).toHaveLength(0);
  });

  it('is silent for the default column strategy, named or omitted', () => {
    expect(warnsFor({ resolver: 'header', database: 'column-per-tenant' })).toHaveLength(0);
    expect(warnsFor({ resolver: 'header' })).toHaveLength(0);
  });
});
