import { describe, expect, it } from 'vitest';
import { restShowcaseFiles } from '../../../src/templates/rest-showcase.ts';

/** The contents of one generated file, failing when it was not emitted. */
function contentsOf(path: string, runtime: 'node' | 'cloudflare-workers'): string {
  const file = restShowcaseFiles(runtime).find((candidate) => candidate.path === path);
  expect(file, path).toBeDefined();
  return file!.contents;
}

describe('the REST showcase greeting test', () => {
  it('boots the real Worker on Workers, never in process', () => {
    const test = contentsOf('src/modules/greeting/greeting.test.ts', 'cloudflare-workers');
    expect(test).toContain("import { startTestServer } from '../../../test/support/server.ts';");
    expect(test).toContain('const server = await startTestServer();');
    expect(test).toContain('await fetch(server.baseUrl + path)');
    expect(test).toContain('assert.deepStrictEqual(await response.json(), { message });');
    expect(test).toContain("from 'node:test'");
    expect(test).not.toContain('createTestApp');
    // The scaffold emits the managed support file; the showcase does not duplicate it.
    expect(
      restShowcaseFiles('cloudflare-workers').some(
        (file) => file.path === 'test/support/server.ts',
      ),
    ).toBe(false);
  });

  it('keeps the in-process test on a socket target', () => {
    const test = contentsOf('src/modules/greeting/greeting.test.ts', 'node');
    expect(test).toContain('createTestApp({ app: await createApp() })');
    expect(test).not.toContain('startTestServer');
  });
});
