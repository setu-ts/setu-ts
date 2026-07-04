import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, createCapabilityToken } from '../../src/tokens.ts';

describe('createCapabilityToken', () => {
  it('should accept lowercase kebab-case names', () => {
    expect(createCapabilityToken('my-capability')).toBe('my-capability');
    expect(createCapabilityToken('cache')).toBe('cache');
    expect(createCapabilityToken('a1-b2')).toBe('a1-b2');
  });

  it('should accept dot-namespaced names', () => {
    expect(createCapabilityToken('acme.payment-gateway')).toBe('acme.payment-gateway');
    expect(createCapabilityToken('a.b.c')).toBe('a.b.c');
  });

  it('should reject uppercase names', () => {
    expect(() => createCapabilityToken('MyCapability')).toThrow(TypeError);
    expect(() => createCapabilityToken('MY-CAP')).toThrow(TypeError);
  });

  it('should reject invalid separators and edges', () => {
    expect(() => createCapabilityToken('')).toThrow(TypeError);
    expect(() => createCapabilityToken('-leading')).toThrow(TypeError);
    expect(() => createCapabilityToken('trailing-')).toThrow(TypeError);
    expect(() => createCapabilityToken('double--dash')).toThrow(TypeError);
    expect(() => createCapabilityToken('under_score')).toThrow(TypeError);
    expect(() => createCapabilityToken('has space')).toThrow(TypeError);
    expect(() => createCapabilityToken('.leading-dot')).toThrow(TypeError);
    expect(() => createCapabilityToken('trailing.')).toThrow(TypeError);
    expect(() => createCapabilityToken('1-starts-with-digit')).toThrow(TypeError);
  });

  it('should include the offending name in the error message', () => {
    expect(() => createCapabilityToken('BAD')).toThrow('BAD');
  });
});

describe('CAPABILITIES', () => {
  it('should contain only valid capability tokens', () => {
    for (const token of Object.values(CAPABILITIES)) {
      expect(createCapabilityToken(token)).toBe(token);
    }
  });

  it('should contain no duplicate token values', () => {
    const values = Object.values(CAPABILITIES);
    expect(new Set(values).size).toBe(values.length);
  });

  it('should expose the mandatory runtime capability', () => {
    expect(CAPABILITIES.RUNTIME).toBe('runtime');
  });
});
