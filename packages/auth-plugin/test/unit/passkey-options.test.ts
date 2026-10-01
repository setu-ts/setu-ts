import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { compilePasskeys } from '../../src/passkeys/ceremonies.ts';
import { MemoryPasskeyStore } from '../../src/stores/passkey-store.ts';
import { AuthPluginConfigurationError } from '../../src/errors.ts';
import type { PasskeyOptions } from '../../src/interfaces/index.ts';

/** A valid option the refusals mutate. */
function valid(overrides: Partial<PasskeyOptions> = {}): PasskeyOptions {
  return {
    rpId: 'localhost',
    rpName: 'Setu Test',
    origins: ['https://localhost'],
    store: new MemoryPasskeyStore(),
    resolvePrincipal: () => Promise.resolve(null),
    ...overrides,
  };
}

describe('compilePasskeys', () => {
  it('applies the userVerification default', () => {
    const compiled = compilePasskeys(valid());
    expect(compiled.userVerification).toBe('required');
    expect(compilePasskeys(valid({ userVerification: 'preferred' })).userVerification).toBe(
      'preferred',
    );
  });

  it('lowercases the rpId', () => {
    const compiled = compilePasskeys(
      valid({ rpId: 'Example.com', origins: ['https://app.example.com'] }),
    );
    expect(compiled.rpId).toBe('example.com');
  });

  it('accepts an rpId that is a registrable suffix of the origin host', () => {
    const compiled = compilePasskeys(
      valid({ rpId: 'example.com', origins: ['https://app.example.com'] }),
    );
    expect(compiled.rpId).toBe('example.com');
  });

  it('accepts an http origin on a loopback host', () => {
    const compiled = compilePasskeys(
      valid({ rpId: 'localhost', origins: ['http://localhost:8443'] }),
    );
    expect(compiled.origins).toEqual(['http://localhost:8443']);
  });

  it('refuses an empty rpId or rpName', () => {
    expect(() => compilePasskeys(valid({ rpId: '' }))).toThrow(AuthPluginConfigurationError);
    expect(() => compilePasskeys(valid({ rpName: '' }))).toThrow(AuthPluginConfigurationError);
  });

  it('refuses an rpId carrying a scheme, port or path', () => {
    expect(() => compilePasskeys(valid({ rpId: 'https://example.com' }))).toThrow(
      AuthPluginConfigurationError,
    );
    expect(() => compilePasskeys(valid({ rpId: 'example.com:443' }))).toThrow(
      AuthPluginConfigurationError,
    );
  });

  it('refuses an rpId that is not the origin host or a suffix of it', () => {
    expect(() => compilePasskeys(valid({ rpId: 'other.com', origins: ['https://example.com'] })))
      .toThrow(AuthPluginConfigurationError);
  });

  it('refuses an empty origin list', () => {
    expect(() => compilePasskeys(valid({ origins: [] }))).toThrow(AuthPluginConfigurationError);
  });

  it('refuses a non-https origin off loopback', () => {
    expect(() => compilePasskeys(valid({ rpId: 'example.com', origins: ['http://example.com'] })))
      .toThrow(AuthPluginConfigurationError);
  });

  it('refuses an origin carrying a path', () => {
    expect(() =>
      compilePasskeys(valid({ rpId: 'example.com', origins: ['https://example.com/app'] }))
    ).toThrow(AuthPluginConfigurationError);
  });

  it('refuses a store that does not implement the port', () => {
    expect(() => compilePasskeys(valid({ store: {} as unknown as MemoryPasskeyStore }))).toThrow(
      AuthPluginConfigurationError,
    );
  });

  it('refuses a non-function resolvePrincipal', () => {
    expect(() =>
      compilePasskeys(
        valid({ resolvePrincipal: undefined as unknown as PasskeyOptions['resolvePrincipal'] }),
      )
    ).toThrow(AuthPluginConfigurationError);
  });

  it('refuses a userVerification outside the three defined values', () => {
    expect(() =>
      compilePasskeys(
        valid({ userVerification: 'sometimes' as unknown as 'required' }),
      )
    ).toThrow(AuthPluginConfigurationError);
  });
});
