/**
 * Tests that every symbol declared in §4 is exported from the barrel.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as barrel from '../../src/index.ts';

describe('barrel exports', () => {
  it('exports FeatureFlagsPlugin', () => {
    expect(barrel.FeatureFlagsPlugin).toBeDefined();
    expect(typeof barrel.FeatureFlagsPlugin).toBe('function');
  });

  it('exports FeatureFlagService', () => {
    expect(barrel.FeatureFlagService).toBeDefined();
    expect(typeof barrel.FeatureFlagService).toBe('function');
  });

  it('exports createProvider', () => {
    expect(barrel.createProvider).toBeDefined();
    expect(typeof barrel.createProvider).toBe('function');
  });

  it('exports createFlagGuard', () => {
    expect(barrel.createFlagGuard).toBeDefined();
    expect(typeof barrel.createFlagGuard).toBe('function');
  });

  it('exports ConfigProvider', () => {
    expect(barrel.ConfigProvider).toBeDefined();
    expect(typeof barrel.ConfigProvider).toBe('function');
  });

  it('exports MemoryProvider', () => {
    expect(barrel.MemoryProvider).toBeDefined();
    expect(typeof barrel.MemoryProvider).toBe('function');
  });

  it('exports DatabaseProvider', () => {
    expect(barrel.DatabaseProvider).toBeDefined();
    expect(typeof barrel.DatabaseProvider).toBe('function');
  });
});
