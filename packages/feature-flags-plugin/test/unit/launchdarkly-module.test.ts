/**
 * Tests for the LaunchDarkly module injection seam.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  adaptLaunchDarklyModule,
  LaunchDarklyModuleError,
  toLoadFailure,
} from '../../src/providers/launchdarkly-module.ts';
import { FakeLaunchDarklyClient, FakeLaunchDarklyModule } from '../fixtures/fake-launchdarkly.ts';

describe('adaptLaunchDarklyModule', () => {
  it('adapts a module exposing a callable init', () => {
    const client = new FakeLaunchDarklyClient();
    const module = adaptLaunchDarklyModule(new FakeLaunchDarklyModule(client));
    const built = module.init('sdk-key-1', { stream: false });
    expect(built).toBe(client);
  });

  it('adapts a plain object literal exposing init', () => {
    const client = new FakeLaunchDarklyClient();
    const module = adaptLaunchDarklyModule({ init: () => client });
    expect(module.init('k')).toBe(client);
  });

  it('throws for a non-object module', () => {
    let caught: unknown;
    try {
      adaptLaunchDarklyModule('not-a-module');
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof LaunchDarklyModuleError).toBe(true);
    expect((caught as Error).message).toContain('must be an object exposing init()');
  });

  it('throws for null', () => {
    expect(() => adaptLaunchDarklyModule(null)).toThrow(LaunchDarklyModuleError);
  });

  it('throws when init is absent or not callable', () => {
    expect(() => adaptLaunchDarklyModule({})).toThrow(LaunchDarklyModuleError);
    let caught: unknown;
    try {
      adaptLaunchDarklyModule({ init: 'nope' });
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof LaunchDarklyModuleError).toBe(true);
    expect((caught as Error).message).toContain('does not expose a callable init()');
  });
});

describe('toLoadFailure', () => {
  it('passes an adaptation failure through unchanged', () => {
    const original = new LaunchDarklyModuleError('module does not expose init()');
    expect(toLoadFailure(original)).toBe(original);
  });

  it('wraps a resolution failure with installation guidance', () => {
    const wrapped = toLoadFailure(
      new Error('Module not found "npm:@launchdarkly/node-server-sdk"'),
    );
    expect(wrapped).toBeInstanceOf(LaunchDarklyModuleError);
    expect(wrapped.message).toContain('Install it to use the');
    expect(wrapped.message).toContain('options.client');
    expect(wrapped.message).toContain('Module not found');
  });

  it('stringifies a non-Error cause', () => {
    const wrapped = toLoadFailure('permission denied');
    expect(wrapped.message).toContain('Cause: permission denied');
  });
});
