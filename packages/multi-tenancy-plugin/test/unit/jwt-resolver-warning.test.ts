/**
 * X18-4: the unverified-JWT caveat is stated where the choice is made — a
 * `register()` warning whenever the RESOLVED chain contains a `JwtResolver`,
 * however it was spelled (`resolver: 'jwt'`, an array containing one, or a
 * bare instance). Silent for every other resolver.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, type ILogger, type IPluginContext } from '@setu-ts/common';

import { MultiTenancyPlugin } from '../../src/plugin/multi-tenancy-plugin.ts';
import { HeaderResolver } from '../../src/resolvers/header-resolver.ts';
import { JwtResolver } from '../../src/resolvers/jwt-resolver.ts';
import { attachRecordingLogger, createRecordingFakeLogger } from '../fixtures/fake-logger.ts';

const decode = (_token: string): Record<string, unknown> | null => ({ tenant_id: 't1' });

/** Minimal plugin context: recording logger, CAPABILITIES.JWT registered. */
function makeContext(): { ctx: IPluginContext; warnCalls: string[] } {
  const recording = createRecordingFakeLogger();
  const logger: ILogger = attachRecordingLogger(recording);
  const ctx = {
    services: {
      has: (token: string) => token === CAPABILITIES.JWT,
      get: () => ({ decode }),
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

describe('jwt resolver warning (X18-4)', () => {
  it("warns for resolver: 'jwt'", () => {
    const warns = warnsFor({ resolver: 'jwt', jwt: { decode } });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('UNVERIFIED');
    expect(warns[0]).toContain('tenant');
  });

  it('warns for a chain containing a JwtResolver', () => {
    const warns = warnsFor({
      resolver: [new HeaderResolver(), new JwtResolver({ decode })],
    });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('UNVERIFIED');
  });

  it('warns for a bare JwtResolver instance', () => {
    // A spelling the plugin's own `isJwtMode` pre-check missed: the RESOLVED
    // chain is what decides.
    const warns = warnsFor({ resolver: new JwtResolver({ decode }) });
    expect(warns).toHaveLength(1);
  });

  it('names the precondition: separate verification of the token', () => {
    const warns = warnsFor({ resolver: 'jwt', jwt: { decode } });
    expect(warns[0]).toContain('verifies');
  });

  it('is silent for every other resolver', () => {
    expect(warnsFor({ resolver: 'header' })).toHaveLength(0);
    expect(warnsFor({ resolver: 'subdomain', subdomain: { baseDomain: 'example.com' } }))
      .toHaveLength(0);
    expect(warnsFor({ resolver: 'path' })).toHaveLength(0);
  });
});
