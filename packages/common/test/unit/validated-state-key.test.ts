/**
 * Unit tests for {@linkcode validatedStateKey} — the cross-package wire format
 * for where a validation middleware stores its parsed value in `ctx.state`.
 *
 * The key string is consumed by `validation-plugin`'s middleware (writer) and,
 * from M70n's E2 subtask onward, by `decorator-plugin`'s parameter resolvers
 * (reader). These tests pin the exact `` `validated:${target}` `` shape so the
 * two packages can never drift apart.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ValidationTarget } from '../../src/index.ts';
import { validatedStateKey } from '../../src/index.ts';

const TARGETS: readonly ValidationTarget[] = ['body', 'query', 'params', 'headers', 'cookies'];

describe('validatedStateKey', () => {
  it('builds `validated:<target>` for every ValidationTarget member', () => {
    expect(validatedStateKey('body')).toBe('validated:body');
    expect(validatedStateKey('query')).toBe('validated:query');
    expect(validatedStateKey('params')).toBe('validated:params');
    expect(validatedStateKey('headers')).toBe('validated:headers');
    expect(validatedStateKey('cookies')).toBe('validated:cookies');
  });

  it('agrees with the template literal for every target', () => {
    for (const target of TARGETS) {
      expect(validatedStateKey(target)).toBe(`validated:${target}`);
    }
  });

  it('is typed as (target: ValidationTarget) => string', () => {
    const fn: (target: ValidationTarget) => string = validatedStateKey;
    expect(typeof fn).toBe('function');
  });
});
