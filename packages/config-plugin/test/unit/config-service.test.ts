/**
 * Unit tests for ConfigService (IConfig implementation).
 *
 * Covers get<T>(key), get<T>(key, { default }), getOrThrow<T>(key),
 * has(key), and edge cases with undefined values.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { ConfigService } from '../../src/services/config-service.ts';

describe('ConfigService', () => {
  it('get returns value when key exists', () => {
    const config = new ConfigService({ PORT: '3000' });
    expect(config.get<string>('PORT')).toBe('3000');
  });

  it('get returns undefined when key is absent', () => {
    const config = new ConfigService({});
    expect(config.get<string>('PORT')).toBeUndefined();
  });

  it('get returns default when key is absent', () => {
    const config = new ConfigService({});
    expect(config.get<string>('PORT', { default: '8080' })).toBe('8080');
  });

  it('get returns actual value when key exists and default provided', () => {
    const config = new ConfigService({ PORT: '3000' });
    expect(config.get<string>('PORT', { default: '8080' })).toBe('3000');
  });

  it('get treats undefined value as absent', () => {
    const config = new ConfigService({ PORT: undefined });
    expect(config.get<string>('PORT')).toBeUndefined();
  });

  it('get returns default for undefined value', () => {
    const config = new ConfigService({ PORT: undefined });
    expect(config.get<string>('PORT', { default: '8080' })).toBe('8080');
  });

  it('getOrThrow returns value when key exists', () => {
    const config = new ConfigService({ PORT: '3000' });
    expect(config.getOrThrow<string>('PORT')).toBe('3000');
  });

  it('getOrThrow throws with key name when absent', () => {
    const config = new ConfigService({});
    expect(() => config.getOrThrow<string>('PORT')).toThrow(
      /"PORT"/,
    );
  });

  it('getOrThrow throws for undefined value', () => {
    const config = new ConfigService({ PORT: undefined });
    expect(() => config.getOrThrow<string>('PORT')).toThrow(
      /"PORT"/,
    );
  });

  it('getOrThrow does not expose other config values in error', () => {
    const config = new ConfigService({ SECRET: 'super-secret' });
    expect(() => config.getOrThrow<string>('MISSING')).toThrow(/"MISSING"/);
    expect(() => config.getOrThrow<string>('MISSING')).not.toThrow(
      /super-secret/,
    );
  });

  it('has returns true for existing key', () => {
    const config = new ConfigService({ PORT: '3000' });
    expect(config.has('PORT')).toBe(true);
  });

  it('has returns false for absent key', () => {
    const config = new ConfigService({});
    expect(config.has('PORT')).toBe(false);
  });

  it('has returns false for undefined value', () => {
    const config = new ConfigService({ PORT: undefined });
    expect(config.has('PORT')).toBe(false);
  });

  it('handles non-string values from schema', () => {
    const config = new ConfigService({ PORT: 3000, DEBUG: true });
    expect(config.get<number>('PORT')).toBe(3000);
    expect(config.get<boolean>('DEBUG')).toBe(true);
  });

  it('get returns value for empty string', () => {
    const config = new ConfigService({ KEY: '' });
    expect(config.get<string>('KEY')).toBe('');
    expect(config.has('KEY')).toBe(true);
  });

  it('is immutable after construction', () => {
    const data = { PORT: '3000' };
    const config = new ConfigService(data);
    // Mutating original should not affect config.
    data.PORT = '9999';
    expect(config.get<string>('PORT')).toBe('3000');
  });
});
