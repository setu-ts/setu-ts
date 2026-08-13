import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { readEnvFilePath } from '../../src/templates/env-file.ts';

describe('readEnvFilePath', () => {
  it('accepts an omitted flag and a valid nested relative path', () => {
    expect(readEnvFilePath({})).toEqual({ ok: true });
    expect(readEnvFilePath({ 'env-file': 'config/.env.local' })).toEqual({
      ok: true,
      path: 'config/.env.local',
    });
  });

  it('rejects a missing, empty, or non-string value', () => {
    for (const value of [true, '', ['.env']] as const) {
      const result = readEnvFilePath({ 'env-file': value });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('needs a relative path');
    }
  });

  it('rejects absolute paths, traversal, and invalid path segments', () => {
    for (const value of ['/etc/env', '../.env', 'config/../.env', 'config//.env', 'env file']) {
      const result = readEnvFilePath({ 'env-file': value });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('inside the generated project');
    }
  });
});
