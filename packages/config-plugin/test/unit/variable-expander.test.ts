import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { expandVariables } from '../../src/services/variable-expander.ts';

describe('expandVariables', () => {
  it('expands direct and recursive references without mutating the input', () => {
    const input = { HOST: 'localhost', ORIGIN: 'http://${HOST}', URL: '${ORIGIN}/api' };
    expect(expandVariables(input)).toEqual({
      HOST: 'localhost',
      ORIGIN: 'http://localhost',
      URL: 'http://localhost/api',
    });
    expect(input.URL).toBe('${ORIGIN}/api');
  });

  it('reuses an already-expanded reference', () => {
    expect(expandVariables({ A: 'value', B: '${A}', C: '${A}' })).toEqual({
      A: 'value',
      B: 'value',
      C: 'value',
    });
  });

  it('detects cycles and reports the involved keys', () => {
    expect(() => expandVariables({ A: '${B}', B: '${C}', C: '${A}' })).toThrow(
      /A -> B -> C -> A/,
    );
  });

  it('throws for a missing reference', () => {
    expect(() => expandVariables({ URL: '${MISSING}' })).toThrow(/MISSING/);
  });

  it('leaves incomplete and nonmatching references literal', () => {
    expect(expandVariables({ A: '${INCOMPLETE', B: '${invalid-name}', C: '$VALUE' })).toEqual({
      A: '${INCOMPLETE',
      B: '${invalid-name}',
      C: '$VALUE',
    });
  });
});

describe('expandVariables | grammar observer (M98e provenance)', () => {
  it('reports each grammatical key exactly once with distinct reference names', () => {
    const seen = new Map<string, readonly string[]>();
    expandVariables(
      {
        HOST: 'localhost',
        ORIGIN: 'http://${HOST}',
        URL: '${ORIGIN}/api/${HOST}',
        PLAIN: 'no-grammar',
      },
      {
        keys: new Set(['HOST', 'ORIGIN', 'URL', 'PLAIN']),
        onExpanded: (key, references) => {
          if (seen.has(key)) {
            throw new Error(`observer fired twice for ${key}`);
          }
          seen.set(key, references);
        },
      },
    );
    // Every key reached as someone else's reference is expanded exactly once
    // and reported — not only the keys the top-level loop starts from.
    expect(seen.get('ORIGIN')).toEqual(['HOST']);
    expect(seen.get('URL')).toEqual(['ORIGIN', 'HOST']);
    expect(seen.has('HOST')).toBe(false); // its raw value has no grammar
    expect(seen.has('PLAIN')).toBe(false);
  });

  it('reports nothing when expansion is a pure copy without the grammar', () => {
    let fired = 0;
    expandVariables({ A: 'plain', B: 'also-plain' }, {
      keys: new Set(['A', 'B']),
      onExpanded: () => {
        fired += 1;
      },
    });
    expect(fired).toEqual(0);
  });

  it('still throws for a missing reference before any record can matter', () => {
    expect(() =>
      expandVariables({ A: '${MISSING}' }, {
        keys: new Set(['A']),
        onExpanded: () => {
          throw new Error('observer must not be consulted on a failed load');
        },
      })
    ).toThrow(/is not defined/);
  });

  it('never scans or reports an unapproved key, while still expanding it', () => {
    const seen: string[] = [];
    const expanded = expandVariables(
      { HOST: 'h', APPROVED: '${HOST}', UNAPPROVED: 'x-${HOST}' },
      { keys: new Set(['APPROVED']), onExpanded: (key) => seen.push(key) },
    );
    expect(expanded['UNAPPROVED']).toEqual('x-h');
    expect(seen).toEqual(['APPROVED']);
  });
});
