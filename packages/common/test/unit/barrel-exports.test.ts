/**
 * Barrel-export assertions for the registry factory arm.
 *
 * A re-export file is fully covered merely by being loaded, so only an
 * assertion that names the symbols from the barrel catches a dropped export
 * (the M56 defect class).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as common from '../../src/index.ts';
import type { HealthCheckResult, IHealthIndicator, IServiceRegistry } from '../../src/index.ts';
import type { RegistryFactory } from '../../src/index.ts';

describe('@setu-ts/common barrel — registry factory arm', () => {
  it('exports resolveRegistryEntry as a function', () => {
    expect(common.resolveRegistryEntry).toBeDefined();
    expect(typeof common.resolveRegistryEntry).toBe('function');
  });

  it('resolveRegistryEntry resolved from the barrel behaves like the direct import', () => {
    const instance: IHealthIndicator = {
      name: 'widget',
      check: (): Promise<HealthCheckResult> => Promise.resolve({ status: 'up' }),
    };
    const services = {} as IServiceRegistry;

    expect(common.resolveRegistryEntry(instance, services, 'label')).toBe(instance);
  });

  it('exports the RegistryFactory type (declared against the barrel)', () => {
    // Compile-time: the type resolves from the barrel and a zero-parameter
    // function is assignable to it (M63 D6 — an unused parameter would fail the
    // generated project's own lint, so the emitted factory takes none).
    const factory: RegistryFactory<IHealthIndicator> = () => ({
      name: 'widget',
      check: (): Promise<HealthCheckResult> => Promise.resolve({ status: 'up' }),
    });

    expect(factory).toBeDefined();
  });
});
