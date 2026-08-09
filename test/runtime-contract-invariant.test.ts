/**
 * Source-derived invariant test preventing the IRuntimeServices guide contract
 * from drifting silently against the actual exported interface in common.
 *
 * Reads the source of packages/common/src/runtime.ts and verifies that every
 * member documented in docs/programmatic-api.md's IRuntimeServices section
 * exists on the real interface.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('IRuntimeServices contract invariant', () => {
  it('programmatic-api.md IRuntimeServices members match packages/common/src/runtime.ts', async () => {
    // Read the actual source to derive the contract.
    const source = await Deno.readTextFile('packages/common/src/runtime.ts');

    // Members that must exist on IRuntimeServices (derived from source).
    const requiredMethods = [
      'platform():',
      'version():',
      'hostname():',
      'uuid():',
      'randomBytes(',
      'now():',
      'hrtime():',
      'setTimeout(',
      'clearTimeout(',
      'setInterval(',
      'clearInterval(',
      'exit(',
    ];
    const requiredProperties = [
      'readonly subtle:',
      'readonly env:',
      'readonly fs?',
      'readonly workers?',
      'readonly dns?',
    ];

    // Verify source declares all required methods.
    for (const method of requiredMethods) {
      expect(source.includes(method)).toBe(true);
    }

    // Verify source declares all required properties.
    for (const prop of requiredProperties) {
      expect(source.includes(prop)).toBe(true);
    }

    // Verify docs/programmatic-api.md documents the contract faithfully.
    // The doc section must mention the key members.
    const doc = await Deno.readTextFile('docs/programmatic-api.md');

    // Check the IRuntimeServices section in docs mentions methods (not properties)
    const runtimeSectionStart = doc.indexOf('### IRuntimeServices');
    expect(runtimeSectionStart).toBeGreaterThan(-1);

    // The next section marker after IRuntimeServices
    const runtimeSectionEnd = doc.indexOf('\n## ', runtimeSectionStart + 1);
    const runtimeSection = runtimeSectionEnd > 0
      ? doc.slice(runtimeSectionStart, runtimeSectionEnd)
      : doc.slice(runtimeSectionStart);

    // Must document methods (platform(), version(), etc.) not properties
    expect(runtimeSection.includes('platform()')).toBe(true);
    expect(runtimeSection.includes('version()')).toBe(true);
    expect(runtimeSection.includes('hostname()')).toBe(true);
    expect(runtimeSection.includes('uuid()')).toBe(true);
    expect(runtimeSection.includes('randomBytes(')).toBe(true);
    expect(runtimeSection.includes('now()')).toBe(true);
    expect(runtimeSection.includes('hrtime()')).toBe(true);
    expect(runtimeSection.includes('setTimeout(')).toBe(true);
    expect(runtimeSection.includes('clearTimeout(')).toBe(true);
    expect(runtimeSection.includes('setInterval(')).toBe(true);
    expect(runtimeSection.includes('clearInterval(')).toBe(true);
    expect(runtimeSection.includes('exit(')).toBe(true);
    expect(runtimeSection.includes('readonly subtle:')).toBe(true);
    expect(runtimeSection.includes('readonly env:')).toBe(true);
    expect(runtimeSection.includes('readonly fs?:')).toBe(true);
    expect(runtimeSection.includes('readonly workers?:')).toBe(true);
    expect(runtimeSection.includes('readonly dns?:')).toBe(true);

    // Must NOT document the wrong shape (property-style platform, missing methods)
    expect(runtimeSection.includes('readonly platform:')).toBe(false);
    expect(runtimeSection.includes('readonly uuid:')).toBe(false);
    expect(runtimeSection.includes('readonly now:')).toBe(false);
    expect(runtimeSection.includes('readonly hrtime:')).toBe(false);
    expect(runtimeSection.includes('typeof setTimeout')).toBe(false);
    expect(runtimeSection.includes('typeof setInterval')).toBe(false);
  });
});
