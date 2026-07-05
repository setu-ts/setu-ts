import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { parseEnv } from '../../src/parsers/env-parser.ts';

describe('parseEnv', () => {
  it('parses comments, blank lines, CRLF, export, and duplicate keys', () => {
    const content = '  # comment\r\n\r\nexport   KEY=first\r\nKEY=second';
    expect(parseEnv(content)).toEqual({ KEY: 'second' });
  });

  it('parses empty and unquoted values while splitting only on the first equals sign', () => {
    expect(parseEnv('EMPTY=\nVALUE=a=b=c   ')).toEqual({ EMPTY: '', VALUE: 'a=b=c' });
  });

  it('strips whitespace-delimited inline comments but preserves embedded hashes', () => {
    expect(parseEnv('A=value # comment\nB=value\t# comment\nC=abc#def')).toEqual({
      A: 'value',
      B: 'value',
      C: 'abc#def',
    });
  });

  it('parses single-quoted values literally', () => {
    expect(parseEnv("VALUE='hello\\n # world' # comment")).toEqual({
      VALUE: 'hello\\n # world',
    });
  });

  it('parses supported and unknown double-quoted escapes', () => {
    const content = String.raw`VALUE="quote: \" slash: \\ newline:\n return:\r tab:\t unknown:\x"`;
    expect(parseEnv(content)).toEqual({
      VALUE: 'quote: " slash: \\ newline:\n return:\r tab:\t unknown:\\x',
    });
  });

  it('allows a comment after a double-quoted value', () => {
    expect(parseEnv('VALUE="hello # world" # comment')).toEqual({ VALUE: 'hello # world' });
  });

  it('throws for a non-entry without leaking its contents', () => {
    const secret = 'not-an-entry-super-secret';
    expect(() => parseEnv(`KEY=value\n${secret}`)).toThrow(/line 2/);
    try {
      parseEnv(secret);
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('throws for an invalid key without leaking it', () => {
    const secretKey = '123-SECRET';
    try {
      parseEnv(`${secretKey}=value`);
      throw new Error('Expected parsing to fail');
    } catch (error) {
      expect((error as Error).message).toContain('line 1');
      expect((error as Error).message).not.toContain(secretKey);
    }
  });

  it('throws for unterminated double quotes with the line number only', () => {
    const secret = 'double-quoted-secret';
    try {
      parseEnv(`VALUE="${secret}`);
      throw new Error('Expected parsing to fail');
    } catch (error) {
      expect((error as Error).message).toContain('line 1');
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('throws for unterminated single quotes with the line number only', () => {
    const secret = 'single-quoted-secret';
    try {
      parseEnv(`VALUE='${secret}`);
      throw new Error('Expected parsing to fail');
    } catch (error) {
      expect((error as Error).message).toContain('line 1');
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('throws for unexpected content after quoted values', () => {
    expect(() => parseEnv('A="value" trailing')).toThrow(/line 1/);
    expect(() => parseEnv("B='value' trailing")).toThrow(/line 1/);
  });

  it('throws for a trailing escape in a double-quoted value', () => {
    expect(() => parseEnv('VALUE="trailing\\')).toThrow(/line 1/);
  });
});
