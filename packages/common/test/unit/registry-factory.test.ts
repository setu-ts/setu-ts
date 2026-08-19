/**
 * Tests for `RegistryFactory` and `resolveRegistryEntry`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { HealthCheckResult, IHealthIndicator, IServiceRegistry } from '../../src/index.ts';
import { resolveRegistryEntry } from '../../src/index.ts';
import type { RegistryFactory } from '../../src/index.ts';

/**
 * A minimal registry. `resolveRegistryEntry` never calls a method on it — it
 * only hands it to a factory — so the members are inert.
 */
function makeRegistry(): IServiceRegistry {
  return {
    register: () => {},
    registerFactory: () => {},
    get: () => {
      throw new Error('no service registered');
    },
    getAll: () => [],
    has: () => false,
    unregister: () => false,
  } as IServiceRegistry;
}

describe('resolveRegistryEntry', () => {
  it('returns a non-function entry unchanged, by reference', () => {
    const instance: IHealthIndicator = {
      name: 'widget',
      check: (): Promise<HealthCheckResult> => Promise.resolve({ status: 'up' }),
    };
    const services = makeRegistry();

    const result = resolveRegistryEntry(instance, services, 'HealthPlugin.indicators[0]');

    expect(result).toBe(instance);
  });

  it('calls a function entry once, passing the registry through by identity', () => {
    const services = makeRegistry();
    const built: IHealthIndicator = {
      name: 'built',
      check: (): Promise<HealthCheckResult> => Promise.resolve({ status: 'up' }),
    };
    let calls = 0;
    const factory: RegistryFactory<IHealthIndicator> = (received) => {
      calls += 1;
      expect(received).toBe(services);
      return built;
    };

    const result = resolveRegistryEntry(factory, services, 'HealthPlugin.indicators[0]');

    expect(result).toBe(built);
    expect(calls).toBe(1);
  });

  it('does not call a factory when the entry is an instance', () => {
    const services = makeRegistry();
    let calls = 0;
    const instance: IHealthIndicator = {
      name: 'widget',
      check: (): Promise<HealthCheckResult> => {
        calls += 1;
        return Promise.resolve({ status: 'up' });
      },
    };

    const result = resolveRegistryEntry(instance, services, 'label');

    expect(result).toBe(instance);
    expect(calls).toBe(0);
  });

  it('wraps a throwing factory in an Error naming the label, with the original as cause', () => {
    const services = makeRegistry();
    const original = new Error("No service registered for capability 'database'");
    const factory: RegistryFactory<IHealthIndicator> = () => {
      throw original;
    };
    const label = 'HealthPlugin.indicators[0]';

    let caught: unknown;
    try {
      resolveRegistryEntry(factory, services, label);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toContain(label);
    expect(error.message).toContain(original.message);
    expect(error.cause).toBe(original);
  });

  it('wraps a non-Error throw from a factory with a stable message', () => {
    const services = makeRegistry();
    const factory: RegistryFactory<IHealthIndicator> = () => {
      throw 'boom';
    };

    let caught: unknown;
    try {
      resolveRegistryEntry(factory, services, 'label');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toContain('label');
    expect(error.message).toContain('boom');
    expect(error.cause).toBe('boom');
  });
});

describe('RegistryFactory assignability', () => {
  it('is not assignable from a class (a constructor is not a call signature)', () => {
    class WidgetHealthIndicator implements IHealthIndicator {
      readonly name = 'widget';
      check(): Promise<HealthCheckResult> {
        return Promise.resolve({ status: 'up' });
      }
    }

    // A class value is `new () => WidgetHealthIndicator`; a factory is
    // `(services) => IHealthIndicator`. The constructor is not callable
    // without `new`, so this is a compile error, not a runtime TypeError.
    // @ts-expect-error a class is not assignable to RegistryFactory<IHealthIndicator>
    const notAFactory: RegistryFactory<IHealthIndicator> = WidgetHealthIndicator;

    expect(notAFactory).toBeDefined();
  });
});
