import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as exports from '../../src/index.ts';
import { createCapabilityToken } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

describe('barrel exports', () => {
  it('should export StaticPlugin', () => {
    expect(exports.StaticPlugin).toBeDefined();
    expect(typeof exports.StaticPlugin).toBe('function');
  });

  it('should export StaticFilesService', () => {
    expect(exports.StaticFilesService).toBeDefined();
    expect(typeof exports.StaticFilesService).toBe('function');
  });

  it('should export createStaticHandler', () => {
    expect(exports.createStaticHandler).toBeDefined();
    expect(typeof exports.createStaticHandler).toBe('function');
  });

  it('should not export types at runtime (types are erased)', () => {
    // TypeScript types are erased at runtime; only values are exported
    expect(Object.keys(exports)).not.toContain('IStaticFiles');
    expect(Object.keys(exports)).not.toContain('StaticPluginOptions');
  });

  it('should have STATIC_FILES token with valid grammar', () => {
    const token = CAPABILITIES.STATIC_FILES;
    expect(token).toBe('static-files');
    // Verify it passes createCapabilityToken validation
    expect(() => createCapabilityToken(token)).not.toThrow();
  });
});
