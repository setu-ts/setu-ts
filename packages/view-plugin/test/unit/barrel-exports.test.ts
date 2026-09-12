/**
 * Pins the published surface.
 *
 * Every other test in this package imports the concrete module rather than
 * the barrel, so dropping a re-export leaves them all green — and a re-export
 * file is fully covered merely by being loaded, so the per-file bar does not
 * see it either. These assertions are declared AGAINST the barrel so a missing
 * export fails `deno check`, not just at runtime (the M56 / M70m defect
 * class; M92 §6).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import * as barrel from '../../src/index.ts';
import type { ViewPluginOptions } from '../../src/index.ts';
import type { IPlugin } from '@setu-ts/common';

// Type-level: fails to compile if the type stops being exported from the
// barrel.
const options: ViewPluginOptions = { engine: 'hono-html' };
void options;

/** The complete published surface, in barrel order. */
const EXPECTED_VALUES = [
  'UnresolvedSuspenseError',
  'ViewRenderError',
  'raw',
  'renderView',
  'ViewPlugin',
] as const;

describe('published barrel surface', () => {
  it('exports exactly the documented values, and nothing else', () => {
    expect(Object.keys(barrel).sort()).toEqual([...EXPECTED_VALUES].sort());
  });

  it('exports renderView — the functional entry point — from the barrel', () => {
    // Dropping this export left every runtime test green once (M56): the
    // plan's negative control 6, asserted here permanently.
    expect(typeof barrel.renderView).toBe('function');
  });

  it('exports ViewPlugin as a plugin factory', () => {
    const plugin: IPlugin = barrel.ViewPlugin();
    expect(plugin.name).toBe('view-plugin');
  });

  it('exports raw — the escaping opt-out — passing markup through', () => {
    expect(String(barrel.raw('<i>kept</i>'))).toBe('<i>kept</i>');
  });

  it('exports both error classes as constructors', () => {
    expect(typeof barrel.ViewRenderError).toBe('function');
    expect(typeof barrel.UnresolvedSuspenseError).toBe('function');
    const error = new barrel.ViewRenderError(function Named() {
      return null;
    }, 'returned null');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Named');
  });
});
