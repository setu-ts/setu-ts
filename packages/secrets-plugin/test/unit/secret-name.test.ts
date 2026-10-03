import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { printableSecretName } from '../../src/services/secret-name.ts';

describe('printableSecretName (M101a security audit)', () => {
  it('returns a name without control characters unchanged', () => {
    expect(printableSecretName('db/password-1.é')).toBe('db/password-1.é');
  });

  it('escapes every C0 control character and DEL', () => {
    expect(printableSecretName('a\r\nb\u0000\u001f\u007f')).toBe(
      'a\\u000d\\u000ab\\u0000\\u001f\\u007f',
    );
  });

  it('escapes C1 controls (NEL, CSI) and the Unicode line and paragraph separators', () => {
    expect(printableSecretName('a\u0085b\u009b31mc\u2028d\u2029e\u0080\u009f')).toBe(
      'a\\u0085b\\u009b31mc\\u2028d\\u2029e\\u0080\\u009f',
    );
  });

  it('leaves the first printable code point after C1 alone', () => {
    expect(printableSecretName('\u00a0é')).toBe('\u00a0é');
  });
});
