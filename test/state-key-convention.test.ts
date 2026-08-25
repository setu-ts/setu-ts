import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CLIENT_IP_STATE_KEY, ERROR_RESPONDER_STATE_KEY, validatedStateKey } from '@setu-ts/common';
import { TENANT_CACHE_PREFIX_STATE_KEY } from '@setu-ts/multi-tenancy-plugin';
import { TELEMETRY_SPAN_KEY } from '@setu-ts/telemetry-plugin';

const KEY_PATTERN = /^([a-z][a-z0-9-]*):[a-z0-9-]+$/;

/**
 * Package directory names, used as the OWNER half of every key.
 *
 * Checking the shape alone is not enough: `setu-ts:session` — the value M71
 * renamed away from — satisfies `<kebab>:<kebab>` and would sail through a
 * shape-only assertion. The owner half must name a package that actually
 * exists, which is what makes the key self-attributing.
 */
const packageNames = new Set(
  (await Array.fromAsync(Deno.readDir('packages')))
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name),
);

/** Reports whether a key is `<existing-package>:<kebab-key>`. */
function isConventional(key: string): boolean {
  const match = KEY_PATTERN.exec(key);
  return match !== null && packageNames.has(match[1]);
}
const STATE_LITERAL = /ctx\.state\.(?:get|set|has|delete)\(\s*['"]/g;

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) {
      result.push(...await sourceFiles(path));
    } else if (entry.isFile && path.endsWith('.ts')) {
      result.push(path);
    }
  }
  return result;
}

describe('ctx.state key convention', () => {
  it('rejects literal state keys in package source', async () => {
    const violations: string[] = [];
    for (const entry of await Array.fromAsync(Deno.readDir('packages'))) {
      if (!entry.isDirectory) continue;
      const source = `packages/${entry.name}/src`;
      let info: Deno.FileInfo;
      try {
        info = await Deno.stat(source);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      if (!info.isDirectory) continue;
      for (const path of await sourceFiles(source)) {
        const lines = (await Deno.readTextFile(path)).split('\n');
        for (let index = 0; index < lines.length; index++) {
          if (STATE_LITERAL.test(lines[index])) violations.push(`${path}:${index + 1}`);
          STATE_LITERAL.lastIndex = 0;
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps every declared *_STATE_KEY constant in the owner-prefixed shape', async () => {
    // Scans the DECLARATIONS rather than importing, so the two keys no barrel
    // exports — `SESSION_STATE_KEY` and `UPLOADS_STATE_KEY` — are covered too,
    // and so a key added next milestone is checked without editing this list.
    const declaration = /[A-Z_]*_STATE_KEY\s*=\s*'([^']+)'/g;
    const offenders: string[] = [];
    let found = 0;
    for (const entry of await Array.fromAsync(Deno.readDir('packages'))) {
      if (!entry.isDirectory) continue;
      const source = `packages/${entry.name}/src`;
      let info: Deno.FileInfo;
      try {
        info = await Deno.stat(source);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      if (!info.isDirectory) continue;
      for (const path of await sourceFiles(source)) {
        const text = await Deno.readTextFile(path);
        for (const match of text.matchAll(declaration)) {
          found += 1;
          if (!isConventional(match[1])) offenders.push(`${path}: ${match[1]}`);
        }
      }
    }
    // Guards against the scan silently matching nothing and passing vacuously.
    expect(found).toBeGreaterThanOrEqual(5);
    expect(offenders).toEqual([]);
  });

  it('keeps exported key values in the owner-prefixed shape', () => {
    const keys = [
      CLIENT_IP_STATE_KEY,
      ERROR_RESPONDER_STATE_KEY,
      TELEMETRY_SPAN_KEY,
      TENANT_CACHE_PREFIX_STATE_KEY,
      validatedStateKey('body'),
    ];
    for (const key of keys) expect(isConventional(key)).toBe(true);
  });
});
