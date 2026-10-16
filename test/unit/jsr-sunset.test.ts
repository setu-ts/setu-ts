import { describe, expect, it } from 'vitest';
import { JSR_PACKAGES, jsrSunsetDescription } from '../../scripts/jsr-sunset.ts';
import { PUBLISHED_PACKAGES } from '../../scripts/release-packages.ts';
import { PACKAGE_METADATA } from '../../scripts/jsr-metadata.ts';

describe('JSR sunset descriptions', () => {
  it('freezes exactly the 49 JSR packages, all published, excluding npm-only additions', () => {
    expect(JSR_PACKAGES).toHaveLength(49);
    expect(new Set(JSR_PACKAGES).size).toBe(49);
    expect(Object.isFrozen(JSR_PACKAGES)).toBe(true);
    const names = PUBLISHED_PACKAGES.map((path) => path.split('/').at(-1));
    for (const name of JSR_PACKAGES) {
      expect(names).toContain(name);
      expect(
        Buffer.byteLength(jsrSunsetDescription(name, PACKAGE_METADATA[name]!.description)),
      ).toBeLessThanOrEqual(250);
    }
    for (const name of ['localization-plugin', 'idempotency-plugin', 'create'])
      expect(JSR_PACKAGES).not.toContain(name);
  });
  it('retains a short base without changing npm metadata', () => {
    expect(jsrSunsetDescription('kernel', 'Plugin kernel.')).toBe(
      'Moved to npm as @setu-ts/kernel; JSR keeps 0.8.0 and earlier. Plugin kernel.',
    );
    expect(PACKAGE_METADATA['kernel']!.description).not.toContain('Moved to npm');
    expect(jsrSunsetDescription('kernel', '  ')).toBe(
      'Moved to npm as @setu-ts/kernel; JSR keeps 0.8.0 and earlier.',
    );
  });
  it('cuts a 300-byte multi-byte base at a space and accounts for the ellipsis', () => {
    const result = jsrSunsetDescription('kernel', 'éé '.repeat(60));
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(250);
    expect(result).toMatch(/ éé…$/u);
    expect(Buffer.byteLength(result + ' éé')).toBeGreaterThan(250);
  });
  it('does not split an unbroken word or the required prefix', () => {
    const prefix = jsrSunsetDescription('kernel', '');
    expect(jsrSunsetDescription('kernel', 'x'.repeat(300))).toBe(`${prefix}…`);
    const name = 'x'.repeat(190);
    expect(Buffer.byteLength(jsrSunsetDescription(name, ''))).toBe(245);
    expect(jsrSunsetDescription(name, 'longword'.repeat(40))).toBe(
      jsrSunsetDescription(name, '') + '…',
    );
    expect(jsrSunsetDescription('x'.repeat(195), 'too long')).toBe(
      jsrSunsetDescription('x'.repeat(195), ''),
    );
  });
  it.each(['\n', '\r', '\t', '\0', '\u007f', '\u0085'])(
    'rejects control characters in either input',
    (control) => {
      expect(() => jsrSunsetDescription('kernel', `base${control}`)).toThrow('control character');
      expect(() => jsrSunsetDescription(`kernel${control}`, 'base')).toThrow('control character');
    },
  );
  it('rejects a prefix exceeding the byte budget', () => {
    expect(() => jsrSunsetDescription('é'.repeat(150), '')).toThrow('prefix exceeds');
  });
});
