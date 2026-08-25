import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CLIENT_IP_STATE_KEY, ERROR_RESPONDER_STATE_KEY, validatedStateKey } from '@setu-ts/common';
import { TENANT_CACHE_PREFIX_STATE_KEY } from '@setu-ts/multi-tenancy-plugin';
import { TELEMETRY_SPAN_KEY } from '@setu-ts/telemetry-plugin';

const KEY_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9-]+$/;
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

  it('keeps exported key values in the owner-prefixed shape', () => {
    const keys = [
      CLIENT_IP_STATE_KEY,
      ERROR_RESPONDER_STATE_KEY,
      TELEMETRY_SPAN_KEY,
      TENANT_CACHE_PREFIX_STATE_KEY,
      validatedStateKey('body'),
    ];
    for (const key of keys) expect(KEY_PATTERN.test(key)).toBe(true);
  });
});
