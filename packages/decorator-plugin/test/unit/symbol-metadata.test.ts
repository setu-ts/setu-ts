import { describe, expect, it } from 'vitest';

import {
  DecoratorMetadataUnavailableError,
  installSymbolMetadata,
  requireDecoratorMetadata,
} from '../../src/metadata/symbol-metadata.ts';

describe('installSymbolMetadata (M111a §3.4)', () => {
  it('installs the registered Symbol.for key on a target that lacks one', () => {
    const target: { metadata?: symbol } = {};
    installSymbolMetadata(target);
    expect(target.metadata).toBe(Symbol.for('Symbol.metadata'));
  });

  it('keeps an existing symbol rather than overwriting it', () => {
    const own = Symbol('own');
    const target: { metadata?: symbol } = { metadata: own };
    installSymbolMetadata(target);
    expect(target.metadata).toBe(own);
  });

  it('is idempotent across repeated installs', () => {
    const target: { metadata?: symbol } = {};
    installSymbolMetadata(target);
    const first = target.metadata;
    installSymbolMetadata(target);
    expect(target.metadata).toBe(first);
  });

  it('leaves the global carrier defined after the module has been imported', () => {
    // Deno ships the well-known symbol, so the module-level call is a no-op
    // here; on Node and Bun it is what defines it. Either way it exists.
    expect(typeof (Symbol as unknown as { metadata?: symbol }).metadata).toBe('symbol');
  });
});

describe('requireDecoratorMetadata (M111a §3.4 safeguard 1)', () => {
  it('returns the carrier when the context carries one', () => {
    const carrier = {};
    expect(requireDecoratorMetadata({ metadata: carrier })).toBe(carrier);
  });

  it('throws the named error for an absent carrier', () => {
    expect(() => requireDecoratorMetadata({})).toThrow(DecoratorMetadataUnavailableError);
  });

  it('throws the named error for a null carrier', () => {
    const context = { metadata: null } as unknown as { metadata?: Record<PropertyKey, unknown> };
    expect(() => requireDecoratorMetadata(context)).toThrow(DecoratorMetadataUnavailableError);
  });

  it('names both remedies and a stable error name', () => {
    const error = new DecoratorMetadataUnavailableError();
    expect(error.name).toBe('DecoratorMetadataUnavailableError');
    expect(error.message).toContain("Import '@setu-ts/decorator-plugin'");
    expect(error.message).toContain('tsx, esbuild, Bun');
  });
});
