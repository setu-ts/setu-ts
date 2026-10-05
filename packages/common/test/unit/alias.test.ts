import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { hasForbiddenAliasCharacter } from '../../src/index.ts';

describe('diagnostics alias characters', () => {
  it('accepts printable Unicode and rejects every C0/C1, format and line/paragraph separator boundary', () => {
    for (const value of ['ascii', 'é'.repeat(20), ' ', '~', '😀']) {
      expect(hasForbiddenAliasCharacter(value)).toBe(false);
    }
    for (let code = 0; code <= 0x9f; code++) {
      expect(hasForbiddenAliasCharacter(String.fromCodePoint(code))).toBe(
        code <= 31 || code >= 127,
      );
    }
    for (
      const code of [
        0x200b,
        0x200e,
        0x202a,
        0x202b,
        0x202c,
        0x202d,
        0x202e,
        0x2028,
        0x2029,
        0x2066,
        0x2067,
        0x2068,
        0x2069,
        0xfeff,
        0xad,
        0xe0001,
      ]
    ) {
      expect(hasForbiddenAliasCharacter(`a${String.fromCodePoint(code)}b`)).toBe(true);
    }
  });
});
