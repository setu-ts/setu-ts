import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

// Import the barrel to verify all expected exports are present
import * as httpSecurity from '../../src/index.ts';

describe('barrel exports', () => {
  it('exports HttpSecurityPlugin factory', () => {
    expect(typeof httpSecurity.HttpSecurityPlugin).toBe('function');
  });

  it('exports corsMiddleware factory', () => {
    expect(typeof httpSecurity.corsMiddleware).toBe('function');
  });

  it('exports securityHeadersMiddleware factory', () => {
    expect(typeof httpSecurity.securityHeadersMiddleware).toBe('function');
  });

  it('exports csrfMiddleware factory', () => {
    expect(typeof httpSecurity.csrfMiddleware).toBe('function');
  });

  it('exports requestSizeMiddleware factory', () => {
    expect(typeof httpSecurity.requestSizeMiddleware).toBe('function');
  });

  it('exports ipSecurityMiddleware factory', () => {
    expect(typeof httpSecurity.ipSecurityMiddleware).toBe('function');
  });

  it('does not export unintended runtime values', () => {
    const expectedExports = new Set([
      'HttpSecurityPlugin',
      'corsMiddleware',
      'securityHeadersMiddleware',
      'csrfMiddleware',
      'requestSizeMiddleware',
      'ipSecurityMiddleware',
    ]);

    const actualExports = new Set(Object.keys(httpSecurity));

    for (const key of actualExports) {
      expect(expectedExports.has(key)).toBe(true);
    }

    for (const key of expectedExports) {
      expect(actualExports.has(key)).toBe(true);
    }
  });
});
