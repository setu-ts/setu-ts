import { describe, expect, it } from 'vitest';

import {
  configuredEnvFilePath,
  isCoveredDotenvName,
  readEnvFilePath,
} from '../../src/templates/env-file.ts';

describe('isCoveredDotenvName', () => {
  it('covers the default name and .env.* names the container rules match', () => {
    for (const name of ['.env', '.env.local', '.env.prod']) {
      expect(isCoveredDotenvName(name)).toBe(true);
    }
  });

  // `.env.example` matches `.env.*` too, but the generated rules deliberately KEEP
  // it for the image, so it is not covered as a secret file.
  it('does not cover the example the rules deliberately keep', () => {
    expect(isCoveredDotenvName('.env.example')).toBe(false);
  });

  it('does not cover a custom name outside the .env family', () => {
    for (const name of ['local.env', 'secrets', '.env.']) {
      expect(isCoveredDotenvName(name)).toBe(false);
    }
  });
});

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

describe('configuredEnvFilePath', () => {
  it('reads a single-segment configured path', () => {
    const source = `{ envFilePath: '.env', envFileOptional: true }`;
    expect(configuredEnvFilePath(source)).toBe('.env');
    expect(configuredEnvFilePath(`{ envFilePath: 'name.env' }`)).toBe('name.env');
    expect(configuredEnvFilePath(`{ envFilePath: "config/app.env" }`)).toBe('config/app.env');
    expect(configuredEnvFilePath(`{ envFilePath: "../.env" }`)).toBeUndefined();
    // A commented-out declaration never wins over the active one.
    expect(
      configuredEnvFilePath(`// envFilePath: "old.env"\nConfigPlugin({ envFilePath: '.env' })`),
    ).toBe('.env');
    expect(configuredEnvFilePath(`/* envFilePath: 'old.env' */ { envFilePath: 'app.env' }`)).toBe(
      'app.env',
    );
    expect(configuredEnvFilePath(`{ url: 'redis://host', envFilePath: 'app.env' } // note`)).toBe(
      'app.env',
    );
  });

  it('returns a valid multi-segment path, leaving the move decision to the caller', () => {
    expect(configuredEnvFilePath(`{ envFilePath: 'config/.env.local' }`)).toBe('config/.env.local');
  });

  it('returns undefined when no path is configured', () => {
    expect(configuredEnvFilePath('export const plugins = [];')).toBeUndefined();
    expect(configuredEnvFilePath(`{ envFileOptional: true }`)).toBeUndefined();
  });

  it('returns undefined for a path that fails validation', () => {
    expect(configuredEnvFilePath(`{ envFilePath: '../.env' }`)).toBeUndefined();
    expect(configuredEnvFilePath(`{ envFilePath: '/etc/env' }`)).toBeUndefined();
    expect(configuredEnvFilePath(`{ envFilePath: 'env file' }`)).toBeUndefined();
  });
});
