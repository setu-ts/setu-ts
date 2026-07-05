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
