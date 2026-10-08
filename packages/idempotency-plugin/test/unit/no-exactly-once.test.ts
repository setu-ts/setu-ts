/**
 * The §0 negative grep: the words "exactly once" appear nowhere in this
 * package's README, its `src/`, or the Idempotency section of PUBLIC_API.md.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

const FORBIDDEN = /exactly[- ]once/i;

/** Every file under a directory, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

describe('the "exactly once" prohibition (M109a §0, §6)', () => {
  it('appears in no src file', () => {
    const offenders = filesUnder('packages/idempotency-plugin/src').filter((path) =>
      FORBIDDEN.test(Deno.readTextFileSync(path))
    );
    expect(offenders).toEqual([]);
  });

  it('appears in neither the package README nor the PUBLIC_API Idempotency section', () => {
    const readme = Deno.readTextFileSync('packages/idempotency-plugin/README.md');
    expect(FORBIDDEN.test(readme)).toBe(false);

    const publicApi = Deno.readTextFileSync('PUBLIC_API.md');
    const section = publicApi.split('## IdempotencyPlugin()')[1]?.split('\n## ')[0] ?? '';
    expect(section.length).toBeGreaterThan(0);
    expect(FORBIDDEN.test(section)).toBe(false);
  });
});
