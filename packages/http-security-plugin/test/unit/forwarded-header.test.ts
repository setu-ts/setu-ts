import { describe, it, expect } from 'vitest';
import { parseForwarded } from '../../src/middleware/forwarded-header.ts';

describe('bounded Forwarded parser', () => {
  it('parses quoted strings, escaped delimiters and case-insensitive names', () => {
    expect(
      parseForwarded(
        ' FoR=192.0.2.1;PrOtO=HTTPS;host="EXAMPLE.com:8443";ext="a\\",b\\\\c" , for="[2001:db8::1]:4711";proto=http',
      ),
    ).toEqual([
      { ip: '192.0.2.1', proto: 'HTTPS', host: 'EXAMPLE.com:8443' },
      { ip: '2001:db8::1', proto: 'http' },
    ]);
  });
  it('strips IPv4 ports and preserves unknown and obfuscated barriers', () => {
    expect(parseForwarded('for="192.0.2.1:443", for=unknown, for=_opaque, proto=https')).toEqual([
      { ip: '192.0.2.1' },
      {},
      {},
      { proto: 'https' },
    ]);
    expect(parseForwarded('for="[::ffff:192.0.2.1]";ext=""')).toEqual([{ ip: '::ffff:192.0.2.1' }]);
  });
  it('refuses malformed input without returning a partial chain', () => {
    for (const bad of [
      '',
      ' ',
      ',',
      'for=',
      '=x',
      'for =192.0.2.1',
      'for=192.0.2.1,',
      'for=192.0.2.1, ',
      'for=192.0.2.1;',
      'for="unterminated',
      'for="a\\',
      'for="a\n"',
      'for="a\u007f"',
      'for=192.0.2.1;FOR=192.0.2.2',
      'for=192.0.2.1/x',
      'for="[garbage]"',
      'for="[::1]:bad"',
      'for="2001:db8::1"',
      'for=hostname',
      'for=256.1.2.3',
      'for=01.2.3.4',
      'for="_"',
    ]) {
      expect(parseForwarded(bad), bad).toBeUndefined();
    }
  });
  it('bounds the complete field to 8 KiB and 64 elements', () => {
    expect(parseForwarded(`for=192.0.2.1;ext="${'a'.repeat(8192)}"`)).toBeUndefined();
    expect(parseForwarded(`ext="${'é'.repeat(4100)}"`)).toBeUndefined();
    expect(parseForwarded(Array(65).fill('for=192.0.2.1').join(','))).toBeUndefined();
    expect(parseForwarded(Array(64).fill('for=192.0.2.1').join(','))).toHaveLength(64);
    const prefix = 'for=192.0.2.1;ext="';
    expect(parseForwarded(`${prefix}${'a'.repeat(8192 - prefix.length - 1)}"`)).toEqual([
      { ip: '192.0.2.1' },
    ]);
  });
});
