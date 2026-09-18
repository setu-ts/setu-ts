/**
 * The `@since` gate's own controls, because a gate that has never been
 * observed failing is not a gate.
 *
 * Every registry and filesystem touch is injected: no test here reaches the
 * network, so a broken gate cannot hide behind a green run that happened to
 * skip everything. The one exception is the final test, which spawns the real
 * script WITHOUT network permission — the literal `exit 0` + `verified 0`
 * contract that keeps a registry outage from failing `check:docs`' `&&` chain.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  collectSinceTags,
  defaultListSourceFiles,
  type FetchLike,
  packageNameFor,
  registryFileUrl,
  resolveFollowingSymbol,
  run,
  symbolPresent,
} from '../../scripts/check-since-tags.ts';

describe('collectSinceTags', () => {
  const WIDGET = `/** A widget.
 *
 * @since 0.5.0
 */
export interface Widget {
  readonly a: string;
}
`;

  it('reads the version and the one-based line', () => {
    const tags = collectSinceTags('src/widget.ts', WIDGET);
    expect(tags).toHaveLength(1);
    expect(tags[0]?.version).toBe('0.5.0');
    expect(tags[0]?.line).toBe(3);
  });

  it('resolves the symbol the tag is attached to', () => {
    expect(collectSinceTags('src/widget.ts', WIDGET)[0]?.symbol).toBe('Widget');
  });

  it('resolves a single-line JSDoc tag', () => {
    const source = `/** Carries a trace parent. @since 0.2.0 */
export const TRACEPARENT = 'traceparent';
`;
    expect(collectSinceTags('src/h.ts', source)[0]?.symbol).toBe('TRACEPARENT');
  });

  it('stops the version at the prose that follows it', () => {
    const source = `/**
 * @since 0.5.0 — the 'queue' arm. Before that the member was populated on write.
 */
export const arm = 'queue';
`;
    expect(collectSinceTags('src/x.ts', source)[0]?.version).toBe('0.5.0');
  });

  it('reads a prerelease literal whole', () => {
    const source = `/** Telemetry. @since 0.1.0-alpha.10 */
export const SPAN = 'span';
`;
    expect(collectSinceTags('src/x.ts', source)[0]?.version).toBe('0.1.0-alpha.10');
  });

  it('leaves a tag on a member unresolved rather than guessing the enclosing symbol', () => {
    const source = `export interface Store {
  /**
   * The mode.
   *
   * @since 0.5.0 — the member was populated on write before this.
   */
  readonly mode: string;
}
`;
    expect(collectSinceTags('src/x.ts', source)[0]?.symbol).toBeNull();
  });
});

describe('resolveFollowingSymbol', () => {
  it('skips a decorator between the comment and the declaration', () => {
    const source = `/** Injects the store.
 * @since 1.0.0
 */
@Injectable()
export class StoreService {}
`;
    expect(resolveFollowingSymbol(source, source.indexOf('1.0.0'))).toBe('StoreService');
  });

  it('returns null when the next code is not a declaration', () => {
    const source = `// migrated in @since 0.1.0
return value;
`;
    expect(resolveFollowingSymbol(source, source.indexOf('0.1.0'))).toBeNull();
  });

  it('handles a tag inside a line comment', () => {
    const source = `// added @since 0.2.0
export function helper() {}
`;
    expect(resolveFollowingSymbol(source, source.indexOf('0.2.0'))).toBe('helper');
  });
});

describe('symbolPresent', () => {
  it('is true when the symbol occurs as a whole word', () => {
    expect(symbolPresent('export interface Widget {}\n', 'Widget')).toBe(true);
  });

  it('is false when the symbol is absent', () => {
    expect(symbolPresent('export interface Store {}\n', 'Widget')).toBe(false);
  });

  it('does not match a longer name that merely begins with the symbol', () => {
    // The whole failure this gate exists for is a tag whose symbol moved or
    // was renamed; a substring match would pass `Widget` against `WidgetV2`.
    expect(symbolPresent('export interface WidgetV2 {}\n', 'Widget')).toBe(false);
    expect(symbolPresent('export interface MyWidget {}\n', 'Widget')).toBe(false);
  });
});

describe('registry URLs and package names', () => {
  it('builds the file URL for a version', () => {
    expect(registryFileUrl('https://jsr.io', '@setu-ts/common', '0.5.0', 'src/form/form-body.ts'))
      .toBe('https://jsr.io/@setu-ts/common/0.5.0/src/form/form-body.ts');
  });

  it('derives the scoped name from a member path, starters included', () => {
    expect(packageNameFor('./packages/common')).toBe('@setu-ts/common');
    expect(packageNameFor('packages/starters/rest-starter')).toBe('@setu-ts/rest-starter');
  });
});

describe('defaultListSourceFiles — the real walk', () => {
  it('finds .ts files under <member>/src, recursively and sorted', async () => {
    const root = '.tmp/check-since-tags-fixture/member';
    await Deno.mkdir(`${root}/src/nested`, { recursive: true });
    await Deno.writeTextFile(`${root}/src/a.ts`, 'export const a = 1;\n');
    await Deno.writeTextFile(`${root}/src/nested/b.ts`, 'export const b = 1;\n');
    await Deno.writeTextFile(`${root}/src/notes.txt`, 'not source\n');
    expect(await defaultListSourceFiles(root)).toEqual([
      `${root}/src/a.ts`,
      `${root}/src/nested/b.ts`,
    ]);
  });

  it('tolerates a member without a src directory', async () => {
    await Deno.mkdir('.tmp/check-since-tags-fixture/bare', { recursive: true });
    expect(await defaultListSourceFiles('.tmp/check-since-tags-fixture/bare')).toEqual([]);
  });
});

/** A fixed in-memory tree the run tests scan. */
const FILES: Record<string, string> = {
  'packages/mock/src/widget.ts': `/** A widget.
 *
 * @since 0.5.0
 */
export interface Widget {
  readonly a: string;
}
`,
  'packages/mock/src/gadget.ts': `/** Single-line. @since 0.6.0 */
export type Gadget = 'big' | 'small';
`,
  'packages/mock/src/gone.ts': `/** Gone at the claimed version.
 * @since 0.5.0
 */
export interface Gone {}
`,
  'packages/mock/src/pair.ts': `/** Two symbols, one file, one version.
 * @since 0.6.0
 */
export const One = 1;

/** Second.
 * @since 0.6.0
 */
export const Two = 2;
`,
  'packages/mock/src/ahead.ts': `/** Ahead of the registry.
 * @since 9.0.0
 */
export const Ahead = true;
`,
  'packages/mock/src/member.ts': `export interface Store {
  /**
   * The mode.
   *
   * @since 0.5.0 — the member was populated on write before this.
   */
  readonly mode: string;
}
`,
};

/** Registry contents backing the fake fetch. */
const REGISTRY: Record<string, string> = {
  'https://jsr.io/@setu-ts/mock/0.5.0/src/widget.ts': 'export interface Store {}\n',
  'https://jsr.io/@setu-ts/mock/0.6.0/src/gadget.ts': "export type Gadget = 'big' | 'small';\n",
  'https://jsr.io/@setu-ts/mock/0.6.0/src/pair.ts':
    'export const One = 1;\nexport const Two = 2;\n',
};

function fakeFetch(
  routes: Record<string, { status: number; body: string } | 'throw'>,
  calls: string[] = [],
): FetchLike {
  return (url: string) => {
    calls.push(url);
    const route = routes[url];
    if (route === 'throw') return Promise.reject(new Error('socket down'));
    if (route === undefined) {
      return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
    }
    return Promise.resolve({
      ok: route.status < 400,
      status: route.status,
      text: () => Promise.resolve(route.body),
    });
  };
}

/** The standard run options over the fixture tree, with routes layered in. */
function options(
  routes: Record<string, { status: number; body: string } | 'throw'> = {},
  calls: string[] = [],
) {
  return {
    manifest: { workspace: ['./packages/mock'] },
    readFile: (path: string) => {
      const content = FILES[path];
      if (content === undefined) return Promise.reject(new Error(`no such file: ${path}`));
      return Promise.resolve(content);
    },
    listSourceFiles: (member: string) => {
      const prefix = `${member.replace(/^\.\//, '')}/`;
      return Promise.resolve(
        Object.keys(FILES).filter((f) => f.startsWith(prefix)).sort(),
      );
    },
    fetchImpl: fakeFetch(
      {
        ...Object.fromEntries(
          Object.entries(REGISTRY).map(([url, body]) => [url, { status: 200, body }]),
        ),
        'https://jsr.io/@setu-ts/mock/meta.json': {
          status: 200,
          body: JSON.stringify({ versions: { '0.5.0': {}, '0.6.0': {} } }),
        },
        ...routes,
      },
      calls,
    ),
  };
}

describe('run', () => {
  it('verifies the tags whose version ships their symbols', async () => {
    const result = await run(options());
    expect(result.verified).toBe(3); // Gadget, and One + Two sharing pair.ts
    // The two deliberately-wrong fixtures fail alongside them; the focused
    // tests below pin each finding kind.
    expect(result.findings).toHaveLength(2);
  });

  it('fails a tag whose version ships the file but not the symbol', async () => {
    const result = await run(options());
    const finding = result.findings.find((f) => f.file.endsWith('widget.ts'));
    expect(finding?.kind).toBe('symbol-absent');
    expect(finding?.message).toContain('Widget');
    expect(finding?.message).toContain('0.5.0');
  });

  it('fails a tag whose version does not contain the file at all', async () => {
    const result = await run(options());
    const finding = result.findings.find((f) => f.file.endsWith('gone.ts'));
    expect(finding?.kind).toBe('file-absent');
    expect(finding?.message).toContain('does not contain');
  });

  it('skips a version the registry has not seen, rather than failing it', async () => {
    const result = await run(options());
    const skip = result.skipped.find((s) => s.file.endsWith('ahead.ts'));
    expect(skip?.reason).toContain('ahead of the registry');
  });

  it('FAILS a version that was never published, rather than reading it as ahead', async () => {
    // The discriminating case. `ahead.ts` above claims 9.0.0, which is
    // genuinely newer than everything the registry holds, so it passes whether
    // the rule is "absent from the list" or "newer than all of them" — it
    // cannot tell the two apart. 0.5.1 can: the registry holds 0.5.0 and
    // 0.6.0, so 0.5.1 is absent AND older than a published version, which
    // means it was skipped over and can never appear. Read as "ahead" it is
    // skipped forever; four such tags (`@since 0.6.1`, on a line that went
    // 0.6.0 -> 0.7.0) were live on `main` and this gate reported none of them.
    const file = 'packages/mock/src/never.ts';
    const source = `/** Never published.\n * @since 0.5.1\n */\nexport const Never = true;\n`;
    const base = options();
    const result = await run({
      ...base,
      readFile: (path: string) => path === file ? Promise.resolve(source) : base.readFile(path),
      listSourceFiles: () => Promise.resolve([file]),
    });
    expect(result.skipped.find((s) => s.file === file)).toBeUndefined();
    const finding = result.findings.find((f) => f.file === file);
    expect(finding?.kind).toBe('version-absent');
    expect(finding?.message).toContain('never published');
  });

  it('skips a version whose release LINE shipped only as a prerelease', async () => {
    // `@since 0.1.0` is the repo-wide spelling for "since the first release",
    // and that line shipped only as `0.1.0-alpha.*` — the exact string is
    // absent from the registry while the release it names plainly exists.
    // Reporting it would have produced 783 findings across the corpus, which
    // is how the first cut of the rule above was caught: the unit test passed
    // and its control discriminated, and the rule was still wrong at scale.
    const file = 'packages/mock/src/first.ts';
    const source = `/** First release.\n * @since 0.1.0\n */\nexport const First = true;\n`;
    const base = options();
    const result = await run({
      ...base,
      readFile: (path: string) => path === file ? Promise.resolve(source) : base.readFile(path),
      listSourceFiles: () => Promise.resolve([file]),
      fetchImpl: fakeFetch({
        'https://jsr.io/@setu-ts/mock/meta.json': {
          status: 200,
          body: JSON.stringify({ versions: { '0.1.0-alpha.3': {}, '0.2.0': {} } }),
        },
      }),
    });
    expect(result.findings).toHaveLength(0);
    expect(result.skipped.find((s) => s.file === file)?.reason).toContain('not on the registry');
  });

  it('does not let a non-semver registry version claim a release line', async () => {
    // The registry's version list is remote input. A value carrying no release
    // triple must not compare equal to 0.0.0 and make an unrelated tag look
    // like it shares that line, so it is dropped before the comparison.
    const file = 'packages/mock/src/never.ts';
    const source = `/** Never published.\n * @since 0.5.1\n */\nexport const Never = true;\n`;
    const base = options();
    const result = await run({
      ...base,
      readFile: (path: string) => path === file ? Promise.resolve(source) : base.readFile(path),
      listSourceFiles: () => Promise.resolve([file]),
      fetchImpl: fakeFetch({
        'https://jsr.io/@setu-ts/mock/meta.json': {
          status: 200,
          body: JSON.stringify({ versions: { 'not-a-version': {}, '0.6.0': {} } }),
        },
      }),
    });
    expect(result.findings.find((f) => f.file === file)?.kind).toBe('version-absent');
  });

  it('treats a 429 or a 5xx as unreachable, never as an absent file', async () => {
    // The outage contract says an unreachable registry SKIPS and exits 0.
    // Reading a rate-limit or a gateway error as absence instead raises a
    // `file-absent` FINDING and exits 1, failing the whole `check:docs` chain
    // on a transient fault — and this gate issues roughly 200 requests a run,
    // so 429 is a realistic answer rather than a hypothetical one.
    for (const status of [429, 503]) {
      const result = await run(options({
        'https://jsr.io/@setu-ts/mock/0.6.0/src/gadget.ts': { status, body: '' },
      }));
      expect(result.findings.filter((f) => f.file.endsWith('gadget.ts'))).toEqual([]);
      expect(result.skipped.some((k) => k.file.endsWith('gadget.ts'))).toBe(true);
    }
  });

  it('treats a non-404 meta response as unreachable, not as an unpublished package', async () => {
    const result = await run(options({
      'https://jsr.io/@setu-ts/mock/meta.json': { status: 503, body: '' },
    }));
    expect(result.findings).toEqual([]);
    expect(result.skipped.some((k) => k.reason.includes('could not be reached'))).toBe(true);
  });

  it('skips a tag whose symbol it cannot resolve', async () => {
    const result = await run(options());
    const skip = result.skipped.find((s) => s.file.endsWith('member.ts'));
    expect(skip?.reason).toContain('could not be resolved');
  });

  it('fetches each (package, version, file) once no matter how many tags share it', async () => {
    // Two tags sharing one file and one version are ONE fetch; the meta
    // document is fetched once per package no matter how many tags read it.
    const calls: string[] = [];
    const result = await run(options({}, calls));
    expect(result.verified).toBe(3); // Gadget + One + Two
    expect(
      calls.filter((url) => url === 'https://jsr.io/@setu-ts/mock/0.6.0/src/pair.ts'),
    ).toHaveLength(1);
    expect(
      calls.filter((url) => url === 'https://jsr.io/@setu-ts/mock/meta.json'),
    ).toHaveLength(1);
  });

  it('fails the run when a fetch rejects, as a skip the operator can see', async () => {
    const result = await run(options({
      'https://jsr.io/@setu-ts/mock/meta.json': 'throw',
    }));
    expect(result.findings).toEqual([]);
    expect(result.verified).toBe(0);
    expect(result.skipped.length).toBeGreaterThan(0);
    // The unresolvable member tag skips before the registry is consulted, so
    // the registry outage is not the reason for every entry — but every tag
    // that REACHED for the registry reports the outage.
    expect(
      result.skipped.filter((s) => s.reason.includes('could not be reached')).length,
    ).toBeGreaterThanOrEqual(6);
  });

  it('skips a tag whose file fetch fails mid-run', async () => {
    const result = await run(options({
      'https://jsr.io/@setu-ts/mock/0.6.0/src/gadget.ts': 'throw',
    }));
    const skip = result.skipped.find((s) => s.file.endsWith('gadget.ts'));
    expect(skip?.reason).toContain('fetch failed');
    expect(result.verified).toBe(2); // the pair still verified
  });

  it('skips every tag of a package with no published versions', async () => {
    const result = await run({
      ...options({
        'https://jsr.io/@setu-ts/mock/meta.json': { status: 404, body: '' },
      }),
    });
    expect(result.findings).toEqual([]);
    expect(result.verified).toBe(0);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it('reports a member whose sources cannot be listed, and moves on', async () => {
    const result = await run({
      ...options(),
      listSourceFiles: () => Promise.reject(new Error('walk exploded')),
    });
    expect(result.findings).toEqual([]);
    expect(result.skipped).toEqual([
      {
        file: 'packages/mock',
        line: 0,
        version: '-',
        reason: 'could not list sources of packages/mock: Error: walk exploded',
      },
    ]);
  });

  it('reports a file it cannot read, and moves on', async () => {
    const result = await run({
      ...options(),
      readFile: (path) => {
        if (path.endsWith('widget.ts')) return Promise.reject(new Error('EISDIR'));
        const content = FILES[path];
        if (content === undefined) {
          return Promise.reject(new Error(`unexpected path ${path}`));
        }
        return Promise.resolve(content);
      },
    });
    const skip = result.skipped.find((s) => s.file.endsWith('widget.ts'));
    expect(skip?.reason).toContain('could not read');
    expect(result.verified).toBe(3);
  });

  it('verifies nothing when the network is down, and exits with a pass shape', async () => {
    const result = await run({
      ...options(),
      fetchImpl: () => Promise.reject(new Error('offline')),
    });
    expect(result).toEqual({
      findings: [],
      skipped: [
        {
          file: 'packages/mock/src/ahead.ts',
          line: 2,
          version: '9.0.0',
          reason: 'the registry could not be reached: Error: offline',
        },
        {
          file: 'packages/mock/src/gadget.ts',
          line: 1,
          version: '0.6.0',
          reason: 'the registry could not be reached: Error: offline',
        },
        {
          file: 'packages/mock/src/gone.ts',
          line: 2,
          version: '0.5.0',
          reason: 'the registry could not be reached: Error: offline',
        },
        {
          file: 'packages/mock/src/member.ts',
          line: 5,
          version: '0.5.0',
          reason: 'no top-level declaration follows the tag; the symbol could not be resolved',
        },
        {
          file: 'packages/mock/src/pair.ts',
          line: 2,
          version: '0.6.0',
          reason: 'the registry could not be reached: Error: offline',
        },
        {
          file: 'packages/mock/src/pair.ts',
          line: 7,
          version: '0.6.0',
          reason: 'the registry could not be reached: Error: offline',
        },
        {
          file: 'packages/mock/src/widget.ts',
          line: 3,
          version: '0.5.0',
          reason: 'the registry could not be reached: Error: offline',
        },
      ],
      verified: 0,
    });
  });
});

describe('the script itself — the literal exit code inside check:docs', () => {
  it(
    'exits 0 with verified 0 when the registry cannot be reached',
    { timeout: 120_000 },
    async () => {
      // check:docs is an && chain, so ANY non-zero status fails the task — an
      // exit-77 convention included. Run the real script with read permission
      // only: every fetch throws NotCapable, the whole run skips, and the gate
      // must still exit 0, printing `verified 0` so silence never reads as a
      // pass. (This is the only test here that touches the real tree; it reads.)
      const command = new Deno.Command('deno', {
        args: ['run', '--allow-read', '--no-prompt', 'scripts/check-since-tags.ts'],
        stdout: 'piped',
        stderr: 'piped',
      });
      const output = await command.output();
      const stdout = new TextDecoder().decode(output.stdout);
      expect(output.success, stdout).toBe(true);
      expect(output.code).toBe(0);
      expect(stdout).toContain('verified 0 tag(s)');
      expect(new TextDecoder().decode(output.stderr)).toContain('skipped');
    },
  );
});
