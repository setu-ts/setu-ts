/**
 * Tests for the starter-composition detection shared by `add` and `generate`.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { composingStarter, STARTER_ARMS } from '../../../src/utils/starter-arms.ts';

describe('composingStarter', () => {
  it('detects each starter factory by its package import', () => {
    for (const starter of STARTER_ARMS) {
      const source =
        `import { ${starter.symbol} } from '@setu-ts/${starter.pkg}';\n` +
        `export default ${starter.symbol}({});`;
      expect(composingStarter(source)?.symbol).toBe(starter.symbol);
    }
  });

  it('does not treat a commented-out import as a composition', () => {
    const source =
      `// import { createRestApp } from '@setu-ts/rest-starter';\n` + `export const plugins = [];`;
    expect(composingStarter(source)).toBeUndefined();
  });

  it('still detects a starter in source the comment mask cannot classify', () => {
    // The mask returns undefined for a template literal, so detection falls
    // back to the raw text rather than missing a composition it can see.
    const source =
      `import { createRestApp } from '@setu-ts/rest-starter';\n` +
      `const note = \`starter\`;\n` +
      `export default createRestApp({});`;
    expect(composingStarter(source)?.symbol).toBe('createRestApp');
  });

  it('returns undefined for a configuration that composes no starter', () => {
    expect(composingStarter('export const plugins = [];')).toBeUndefined();
  });
});
