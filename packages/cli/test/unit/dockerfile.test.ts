/**
 * X10-5: the generated Dockerfile folds the `chown` into the cache layer.
 *
 * A standalone `RUN chown -R` rewrites metadata on every file the cache layer
 * created, so overlayfs copies the ENTIRE module cache into a second layer —
 * measured at 563 MB vs 362 MB with the fold, paid on every push and every
 * node pull. These assertions pin the emitted text, the only level this
 * repository can gate (the plan does not claim a cluster re-measurement).
 *
 * @module
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOCKERFILE,
  renderDockerfile,
  workspaceContainerFiles,
} from '../../src/workspace/compose.ts';
import { workspaceProfile } from '../../src/workspace/runtime-profile.ts';
import { WORKSPACE_VERSION, type WorkspaceManifest } from '../../src/workspace/manifest.ts';
import { brokerSpec } from '../../src/workspace/transport.ts';

/** The Deno-profile Dockerfile for a one-member workspace. */
function dockerfile(): string {
  const manifest: WorkspaceManifest = {
    version: WORKSPACE_VERSION,
    runtime: 'deno',
    basePort: 3000,
    broker: 'memory',
    members: [{ name: 'orders', port: 3000 }],
  };
  const files = workspaceContainerFiles(manifest, brokerSpec('memory'));
  const file = files.find((candidate) => candidate.path === DOCKERFILE);
  expect(file).toBeDefined();
  return file?.contents ?? '';
}

describe('generated Dockerfile chown fold (X10-5)', () => {
  it('X87-4 removes testing and diagnostics from the Deno runtime import map', () => {
    const source = dockerfile();
    expect(source).toContain('delete manifest.imports["@setu-ts/testing"]');
    expect(source).toContain('delete manifest.imports["@setu-ts/diagnostics-plugin"]');
  });
  it('one RUN carries the cache, node_modules and the ownership fixup', () => {
    const contents = dockerfile();
    const runLines = contents.split('\n').filter((line) => line.startsWith('RUN '));

    const installRun = runLines.find((line) =>
      line.includes('deno install --cached-only --frozen'),
    );
    expect(installRun).toBeDefined();
    // Same line, same layer: `&&`, not two instructions. DENO_UID interpolates
    // to its numeric value in the emitted text. The cache is copied in by this
    // RUN, so node_modules's hard links into it and the chown store each file once.
    expect(installRun).toContain('cp -a /tmp/.setu-fetched-cache/. /deno-dir/');
    expect(installRun).toContain('&& chown -R 1000:1000 /srv /deno-dir');
    // The fetch stage is never shipped, so it carries no chown.
    const fetchRun = runLines.find((line) =>
      line.includes('&& deno cache --node-modules-dir=none main.ts'),
    );
    expect(fetchRun).toBeDefined();
    expect(fetchRun).not.toContain('chown');
  });

  it('no standalone chown line remains', () => {
    const contents = dockerfile();
    const standalone = contents.split('\n').filter((line) => /^RUN chown\b/.test(line.trim()));
    expect(standalone).toEqual([]);
  });

  it('keeps the numeric-UID comment intact', () => {
    const contents = dockerfile();
    expect(contents).toContain('NUMERIC, not `USER deno`');
    expect(contents).toContain('cannot verify user is non-root');
  });
});

describe('generated Dockerfile lockfile verification', () => {
  it.each([true, false])(
    'runs the Bun check without registry credentials (workspace %s)',
    (workspace) => {
      const check = renderDockerfile(workspaceProfile('bun'), workspace)
        .split('\n')
        .find((line) => line.startsWith('RUN ') && line.includes('bun run check'));
      expect(check).toBeDefined();
      expect(check).not.toContain('--mount=type=secret');
    },
  );
  it('builds a declared frontend on glibc and copies only its output before caching', () => {
    const contents = dockerfile();
    const frontend = contents.slice(
      contents.indexOf('FROM denoland/deno:debian-2.9.5 AS frontend'),
      contents.indexOf('FROM denoland/deno:alpine-2.9.5'),
    );
    expect(frontend).not.toBe('');
    // Parsed from the MEMBER manifest (the stage's working directory), never a
    // root task, and never by matching text.
    expect(frontend).toContain('"jsr:@std/jsonc@1.0.3"');
    expect(frontend).toContain('for (const task of ["build", "check"])');
    expect(frontend).toContain('if (manifest.tasks && task in manifest.tasks)');
    expect(frontend).toContain(
      '--allow-read=./deno.json,./deno.jsonc --allow-write=./.setu-build-task,./.setu-check-task,./.setu-check-cli,./deno.json,./deno.jsonc -',
    );
    expect(frontend).toContain(
      'if [ -f .setu-build-task ]; then deno install --cached-only && deno task build; else mkdir -p build; fi',
    );
    const runs = frontend.split('\n').filter((line) => line.startsWith('RUN '));
    const cache = runs.find((line) =>
      line.includes('deno cache --node-modules-dir=none main.ts setu.config.ts'),
    );
    const check = runs.find((line) => line.includes('deno task check'));
    expect(cache).toContain('--mount=type=secret');
    expect(cache).not.toContain('deno task check');
    expect(check).toBeDefined();
    expect(check).not.toContain('--mount=type=secret');
    expect(runs.indexOf(cache!)).toBeLessThan(runs.indexOf(check!));
    const runtime = contents.slice(contents.indexOf('FROM denoland/deno:alpine-2.9.5'));
    const copy = runtime.indexOf('COPY --from=frontend /srv/apps/${MEMBER}/buil[d] ./build/');
    expect(copy).toBeGreaterThan(-1);
    expect(copy).toBeLessThan(runtime.indexOf('deno cache --node-modules-dir=none main.ts'));
    expect(runtime).not.toContain('deno task build');
  });
  it('switches an auto node_modules root to manual after installing, before the chown', () => {
    const buildRun = dockerfile()
      .split('\n')
      .find(
        (line) => line.startsWith('RUN ') && line.includes('deno install --cached-only --frozen'),
      )!;
    const rewrite = buildRun.indexOf('manifest.nodeModulesDir === "auto"');
    expect(rewrite).toBeGreaterThan(
      buildRun.lastIndexOf('deno install --cached-only --entrypoint main.ts --frozen'),
    );
    expect(rewrite).toBeLessThan(buildRun.indexOf('chown -R'));
    expect(buildRun).toContain('manifest.nodeModulesDir = "manual"');
    expect(buildRun).toContain(
      '--allow-read=/srv/deno.json,/srv/deno.jsonc --allow-write=/srv/deno.json,/srv/deno.jsonc -',
    );
  });
  it('completes the lockfile and then VERIFIES it, in one build layer', () => {
    const contents = dockerfile();
    const runLines = contents.split('\n').filter((line) => line.startsWith('RUN '));
    const buildRun = runLines.find((line) =>
      line.includes('&& deno cache --node-modules-dir=none main.ts'),
    );
    const verifyRun = runLines.find((line) => line.includes('deno install --cached-only --frozen'));
    expect(buildRun).toBeDefined();

    // Deno records a jsr package's npm edge list nondeterministically on a cold
    // cache: four `--no-cache` builds of one unchanged workspace left
    // `@setu-ts/messaging-plugin` missing its `npm:amqplib`/`npm:ioredis` edges
    // twice and complete twice, while both packages were recorded in the
    // lockfile's package section every time. Runtime `--frozen` does not write
    // the lockfile, so against an incomplete one it refuses and every container
    // dies at registration from an image that built green.
    //
    // `deno install` completes the edge lists the frozen check compares against
    // — the same resolver writes and verifies them, which is what makes the pair
    // coherent — so a still-missing edge fails the BUILD rather than every
    // container. Both halves are load-bearing, measured against the real image
    // from a lockfile with every framework npm edge stripped: dropping the
    // repairing install fails the build (exit 1), and dropping `--frozen` is what
    // let the incomplete lockfile reach production in the first place.
    expect(buildRun).toContain(
      'deno cache --node-modules-dir=none main.ts && deno install --node-modules-dir=none && deno install --node-modules-dir=none --frozen && deno install --node-modules-dir=none --entrypoint main.ts && deno install --node-modules-dir=none --entrypoint main.ts --frozen',
    );
    // The fetch fills only the cache; the step after it, without the registry
    // token, installs from that cache and verifies the lockfile again.
    expect(verifyRun).toContain(
      'deno install --cached-only --frozen && deno install --cached-only --entrypoint main.ts --frozen',
    );
    expect(verifyRun).not.toContain('type=secret');
    expect(runLines.indexOf(verifyRun!)).toBe(runLines.indexOf(buildRun!) + 1);
  });

  it('pairs that verification with a `--frozen` runtime', () => {
    // One decision in two halves: the build proves the lockfile complete and the
    // runtime refuses to write it. Dropping either silently restores a failure —
    // without `--frozen` a container updates the shipped lockfile, and without
    // the verify an incomplete one reaches production and never serves.
    expect(dockerfile()).toContain('CMD ["run", "--frozen"');
  });
});

describe('generated Dockerfile development-pin pruning (M101f audit F3)', () => {
  it('runs an exactly pinned parser that may touch only the four manifests', () => {
    // The only step in the image that fetches without the lockfile: a floating
    // range or an all-permission `deno eval` would let it change underneath an
    // unchanged project, or reach beyond the two manifests it edits.
    const pruning = dockerfile()
      .split('\n')
      .find((line) => line.includes('@setu-ts/diagnostics-plugin'));
    expect(pruning).toBeDefined();
    expect(pruning).toContain('"jsr:@std/jsonc@1.0.3"');
    expect(pruning).not.toMatch(/jsr:@std\/jsonc@[\^~]/);
    expect(pruning).not.toContain('deno eval');
    expect(pruning).toContain('deno run --no-config --no-lock --no-prompt');
    const manifests = './deno.json,./deno.jsonc,/srv/deno.json,/srv/deno.jsonc';
    expect(pruning).toContain(`--allow-read=${manifests} --allow-write=${manifests} -`);
    expect(pruning).not.toMatch(/--allow-(read|write)=\/srv[ ,]/);
    expect(pruning).not.toMatch(/--allow-all|\s-A\s/);
  });
});

describe('the credential-free registry settings (#592 review)', () => {
  /**
   * Runs the generated filter exactly as the Dockerfile embeds it, on Node with
   * the two Deno calls it makes mapped onto files in a temporary directory.
   */
  function filter(npmrc: string | undefined): string {
    const program = /printf '%s' '(let source = [^']*)'/.exec(dockerfile())?.[1];
    expect(program).toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), 'setu-npmrc-'));
    try {
      const input = join(dir, 'npmrc');
      const output = join(dir, 'out');
      if (npmrc !== undefined) writeFileSync(input, npmrc);
      const shim = [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        'class NotFound extends Error {}',
        `const paths = { '/root/.npmrc': ${JSON.stringify(input)}, '/tmp/.setu-npmrc': ${JSON.stringify(output)} };`,
        'globalThis.Deno = {',
        '  errors: { NotFound },',
        "  readTextFileSync(path) { try { return readFileSync(paths[path], 'utf8'); } catch (error) { if (error.code === 'ENOENT') throw new NotFound(); throw error; } },",
        '  writeTextFileSync(path, text) { writeFileSync(paths[path], text); },',
        '};',
      ].join('\n');
      writeFileSync(join(dir, 'filter.mjs'), `${shim}\n${program!}\n`);
      execFileSync(process.execPath, [join(dir, 'filter.mjs')]);
      return readFileSync(output, 'utf8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('keeps only registry and scope-registry lines, without userinfo', () => {
    expect(
      filter(
        [
          'registry=https://bob:s3cret@npm.example.com/',
          '@acme:registry = https://pkgs.acme.dev/npm/',
          '//npm.example.com/:_authToken=TOKEN-ABC',
          'always-auth=true',
          '; registry=https://commented.example.com/',
          '',
        ].join('\r\n'),
      ),
    ).toBe('registry=https://npm.example.com/\n@acme:registry=https://pkgs.acme.dev/npm/\n');
  });

  it('writes an empty file when no secret is mounted, so the bind mount always has a source', () => {
    expect(filter(undefined)).toBe('\n');
  });

  it('reads quoted values and inline comments as Deno does, and drops query and fragment', () => {
    expect(
      filter(
        [
          'registry="https://bob:s3cret@npm.example.com/"',
          "@a:registry='https://a.example/npm/?token=QQQ#frag'",
          '@b:registry=https://b.example/ ; private',
          '@c:registry = https://c.example/npm/ # comment',
          '',
        ].join('\n'),
      ),
    ).toBe(
      [
        'registry=https://npm.example.com/',
        '@a:registry=https://a.example/npm/',
        '@b:registry=https://b.example/',
        '@c:registry=https://c.example/npm/',
        '',
      ].join('\n'),
    );
  });

  it('fails closed on a value that is not a URL, naming the key and never the value', () => {
    expect(() => filter('@x:registry=not-a-url-SECRET\n')).toThrow(
      /the npmrc @x:registry setting is not a URL/,
    );
    expect(() => filter('@x:registry=not-a-url-SECRET\n')).not.toThrow(/SECRET/);
  });

  it('copies a value holding an environment reference as written', () => {
    expect(filter('registry=${PRIVATE_REGISTRY}\n')).toBe('registry=${PRIVATE_REGISTRY}\n');
    expect(filter('@p:registry=https://${HOST}/npm/\n')).toBe('@p:registry=https://${HOST}/npm/\n');
    expect(filter('@q:registry=https://npm.corp:${PORT}/npm/\n')).toBe(
      '@q:registry=https://npm.corp:${PORT}/npm/\n',
    );
  });

  it('fails closed on userinfo, a query or a fragment beside an environment reference', () => {
    for (const line of [
      'registry=https://ci:hunter2@npm.corp/${SCOPE}/',
      '@a:registry=https://npm.corp/${P}/?token=LITERAL',
      // A reference where a host name is not valid, which a URL parse could not see past.
      'registry=https://user:hunter2@host:${PORT}/npm/',
      'registry=https://host:${PORT}/npm/?token=LITERAL',
      'registry=https://user:hunter2@[${H}]/',
      // A credential built from references is refused too: it cannot be removed either.
      'registry=https://${U}:${P}@npm.corp/',
      '@a:registry="https://npm.corp/a#${F}"',
    ]) {
      expect(() => filter(`${line}\n`)).toThrow(
        /has an environment reference and userinfo, a query or a fragment/,
      );
      expect(() => filter(`${line}\n`)).not.toThrow(/hunter2|LITERAL/);
    }
  });

  it('copies a credential-free URL exactly as Deno read it', () => {
    expect(filter('registry = https://Npm.Example.com:8443/a/b\n')).toBe(
      'registry=https://Npm.Example.com:8443/a/b\n',
    );
  });
});
