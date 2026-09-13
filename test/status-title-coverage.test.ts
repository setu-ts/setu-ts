/**
 * Every status the framework BRANDS must have a `STATUS_TITLES` row.
 *
 * `withHttpStatusHint` (in `@setu-ts/common`) is how a package that may not
 * import `@setu-ts/exceptions` states the status its own error should be
 * answered with. Such an error never passes a factory, so it reaches the
 * Problem Details formatter as a bare status — and the formatter derives the
 * `title` from `statusTitle(status)`, which falls through to the generic
 * `'Error'` for a status the table does not know.
 *
 * M94b's form accessor brands `415`, the first branded status with no factory
 * and no table row, and a client read `"title": "Error"` under `'rfc9457'`
 * while the same error read `"message": "Unsupported Media Type"` under
 * `'default'` — the two configured formats disagreeing about one error. Every
 * test at the time asserted `httpStatusHintOf(err)?.title`, the brand on the
 * error OBJECT; none read the served body, so nothing saw it.
 *
 * This gate closes the class rather than the instance: the branded statuses are
 * read out of first-party source, so a package that brands a NEW status fails
 * here instead of shipping a meaningless title to a client.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { STATUS_TITLES, statusTitle } from '@setu-ts/exceptions';

/** Recursively collects every `.ts` file under a directory. */
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

/**
 * Finds the `status:` literal of every `withHttpStatusHint({ … })` brand.
 *
 * The brand object always follows the call within a few lines and always
 * carries a numeric `status` (the helper itself rejects a non-integer, and one
 * outside `400`–`599`), so a bounded look-ahead from each call site is enough.
 */
function brandedStatuses(source: string): number[] {
  const found: number[] = [];
  const call = /withHttpStatusHint\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(source)) !== null) {
    const window = source.slice(match.index, match.index + 400);
    const status = /\bstatus:\s*(\d{3})\b/.exec(window);
    if (status !== null) found.push(Number(status[1]));
  }
  return found;
}

describe('STATUS_TITLES covers every status the framework brands', () => {
  it('names a canonical title for each branded status', async () => {
    const packages = (await Array.fromAsync(Deno.readDir('packages')))
      .filter((entry) => entry.isDirectory);

    const statuses = new Set<number>();
    const origins = new Map<number, string>();
    for (const pkg of packages) {
      let files: string[];
      try {
        files = await sourceFiles(`packages/${pkg.name}/src`);
      } catch {
        continue; // a package without a src/ (a starter directory)
      }
      for (const file of files) {
        for (const status of brandedStatuses(await Deno.readTextFile(file))) {
          statuses.add(status);
          if (!origins.has(status)) origins.set(status, file);
        }
      }
    }

    // Vacuity guard: a broken scan must FAIL, never pass by finding nothing.
    // The M50 lesson — a grep-shaped gate whose "empty" result is a false pass.
    expect(statuses.size).toBeGreaterThanOrEqual(4);
    expect(statuses.has(415)).toBe(true); // M94b's form accessor, the instance that prompted this

    const missing = [...statuses]
      .filter((status) => STATUS_TITLES[status] === undefined)
      .map((status) => `${status} (branded in ${origins.get(status)})`);
    expect(missing).toEqual([]);

    // And the consequence the table exists to prevent, stated directly.
    for (const status of statuses) {
      expect(statusTitle(status)).not.toBe('Error');
    }
  });
});
