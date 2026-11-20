/**
 * `setu.W007` page-fetches-own-api (M142 §3.12). The reported and ignored
 * shapes are data tables, so the module comment cannot claim a set the scanner
 * does not implement.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { runCli } from '../../../src/cli.ts';
import { createLineMapper, pageApiFetches } from '../../../src/diagnostics/page-fetch.ts';
import { scanPageImports } from '../../../src/diagnostics/page-imports.ts';
import { lexApiFetches } from '../../../src/utils/import-specifiers.ts';
import { createFakeFs, createRecorder } from '../../fixtures/fake-fs.ts';

const PAGE = 'app/routes/_app/orders._index.tsx';

/** Scans one page and returns its W007 findings. */
async function fetchesIn(source: string, path = PAGE) {
  const scan = await scanPageImports(createFakeFs({ [`/p/${path}`]: source }), '/p');
  expect(scan.unreadable).toEqual([]);
  return scan.fetches;
}

/** Shapes that fetch the application's own API: each is reported with its target. */
const REPORTED: readonly (readonly [label: string, source: string, target: string])[] = [
  ['a string', "await fetch('/api/orders');", '/api/orders'],
  ['a double-quoted string', 'await fetch("/api/orders", { method: "POST" });', '/api/orders'],
  ['a template literal', 'await fetch(`/api/orders/${id}`);', '/api/orders/${…}'],
  ['a template without substitutions', 'await fetch(`/api/orders`);', '/api/orders'],
  ['window.fetch', "await window.fetch('/api/orders');", '/api/orders'],
  ['globalThis.fetch', "await globalThis.fetch('/api/orders');", '/api/orders'],
  ['self.fetch', "await self.fetch('/api/orders');", '/api/orders'],
  [
    'a call inside a template substitution',
    "const s = `count: ${await fetch('/api/count')}`;",
    '/api/count',
  ],
];

/** Shapes that are not a page fetching its own API: nothing is reported. */
const IGNORED: readonly (readonly [label: string, source: string])[] = [
  ['an absolute URL', "await fetch('https://api.example.test/api/orders');"],
  ['a path that only starts with /api', "await fetch('/apis/orders');"],
  ['/api with no trailing slash', "await fetch('/api');"],
  ['another path', "await fetch('/orders.data');"],
  ['a line comment', "// await fetch('/api/orders');"],
  ['a block comment', "/* await fetch('/api/orders'); */"],
  ['a string holding the call', 'const s = "fetch(\'/api/orders\')";'],
  ['template text holding the call', "const s = `fetch('/api/orders')`;"],
  ['another object’s fetch method', "await client.fetch('/api/orders');"],
  ['a nested host', "await frame.window.fetch('/api/orders');"],
  ['a differently named function', "await refetch('/api/orders');"],
  ['a variable argument', 'await fetch(url);'],
  ['fetch used as a value', "const get = fetch; await get('/api/orders');"],
];

describe('W007 page-fetches-own-api', () => {
  for (const [label, body, target] of REPORTED) {
    it(`reports ${label}`, async () => {
      const source = `export async function load(id: string) {\n  ${body}\n}\n`;
      expect(await fetchesIn(source)).toEqual([{ path: PAGE, line: 2, target }]);
    });
  }

  for (const [label, body] of IGNORED) {
    it(`ignores ${label}`, async () => {
      const source = `export async function load(url: string, client: { fetch(u: string): unknown }, frame: any) {\n  ${body}\n}\n`;
      expect(await fetchesIn(source)).toEqual([]);
    });
  }

  it("maps each call to its own line in a TSX page, past JSX text such as it's", async () => {
    const source = [
      "import { useEffect } from 'react';", // 1
      '', // 2
      'export default function Orders() {', // 3
      '  useEffect(() => {', // 4
      "    void fetch('/api/orders');", // 5
      '  }, []);', // 6
      '  return (', // 7
      '    <section>', // 8
      "      <p>it's {`${1}`}</p>", // 9
      '      <button', // 10
      '        onClick={() =>', // 11
      '          fetch(`/api/orders/${1}`, { method: "DELETE" })', // 12
      '        }', // 13
      '      />', // 14
      '    </section>', // 15
      '  );', // 16
      '}', // 17
    ].join('\n');
    expect(await fetchesIn(source)).toEqual([
      { path: PAGE, line: 5, target: '/api/orders' },
      { path: PAGE, line: 12, target: '/api/orders/${…}' },
    ]);
  });

  it('skips React Router server-only modules, as E017 does', async () => {
    expect(await fetchesIn("await fetch('/api/orders');", 'app/server/orders.server.ts')).toEqual(
      [],
    );
  });

  it('warns through setu check, passes unless strict, and is silenced by id', async () => {
    const run = async (seed: Record<string, string>, args: readonly string[]) => {
      const err = createRecorder();
      const log = createRecorder();
      const code = await runCli(args, {
        fs: createFakeFs(seed),
        cwd: '/app',
        now: () => 0,
        log: log.sink,
        error: err.sink,
      });
      return { code, err: err.text(), log: log.text() };
    };
    const seed = {
      '/app/package.json': '{}',
      [`/app/${PAGE}`]: "export async function action() {\n  await fetch('/api/orders');\n}\n",
    };
    const warned = await run(seed, ['check']);
    expect(warned.code).toBe(0);
    expect(warned.err).toContain(
      `warning setu.W007: ${PAGE}:2 fetches /api/orders, the application's own API.`,
    );
    expect(warned.err).toContain('A page writes through its action');
    expect((await run(seed, ['check', '--strict'])).code).toBe(1);
    const silenced = await run(
      { ...seed, '/app/.setu-ts/check.json': JSON.stringify({ silence: ['setu.W007'] }) },
      ['check', '--strict'],
    );
    expect(silenced.code).toBe(0);
    expect(silenced.err).not.toContain('setu.W007');
    expect(silenced.log).toContain('1 silenced');
  });
});

/** One lookup through a fresh mapper. */
function lineAt(mappings: string, emitted: string, offset: number): number {
  return createLineMapper(mappings, emitted)(offset);
}

describe('the W007 building blocks', () => {
  it('lexApiFetches refuses source it cannot tokenize', () => {
    expect(lexApiFetches("fetch('/api/x")).toBeUndefined();
    expect(pageApiFetches(PAGE, "fetch('/api/x", '')).toBe('unreadable');
  });

  it('the line mapper falls back to line 1 without a mapping and stops at a bad character', () => {
    expect(lineAt('', 'a\nb', 2)).toBe(1);
    // AACA: column 0, source 0, line +1, column 0 — so line 2 of the original.
    expect(lineAt(';AACA', 'a\nb', 2)).toBe(2);
    // A segment outside Base64 ends the read with what was found before it.
    expect(lineAt(';AACA,!', 'a\nbc', 3)).toBe(2);
    expect(lineAt(';!', 'a\nb', 2)).toBe(1);
    // A column before the line's first mapping has no mapping of its own.
    expect(lineAt(';EACA', 'a\nbcd', 2)).toBe(1);
  });

  it('maps a page with many calls in linear time, not once per call over the whole map', async () => {
    const page = (count: number) =>
      `export async function load() {\n${"  await fetch('/api/x');\n".repeat(count)}}\n`;
    const timed = async (count: number) => {
      const started = performance.now();
      expect(await fetchesIn(page(count))).toHaveLength(count);
      return performance.now() - started;
    };
    await timed(500);
    const small = await timed(1_000);
    const large = await timed(4_000);
    // Four times the calls: about four times the work, where a per-call decode was about sixteen.
    expect(large / small).toBeLessThan(10);
  });
});
