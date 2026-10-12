/**
 * Packs every published workspace member into npm tarballs, once per tree.
 *
 * Shared by the registry overlay (`registry-overlay.ts`), which serves the packs
 * to the gates that install a scaffolded project, and by `check-node-build.ts`.
 * Built on `node:` APIs only, so both Vitest on Node and a Deno script can run
 * it.
 *
 * The packs are cached under `<root>/.tmp/overlay/<key>`, where the key hashes
 * every input a pack is built from: each published member's `src/`,
 * `package.json` and `tsconfig.json`, and the root inputs every build inherits —
 * `tsconfig.base.json`, the root `package.json`, `pnpm-lock.yaml` and this
 * script. A change to any of them is a new key, so a stale pack is never served.
 * A cache directory is published by an atomic rename, so concurrent callers
 * either build it or find it complete, never half-written.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { PUBLISHED_PACKAGES } from './release-packages.ts';

const run = promisify(execFile);

/** One packed member. */
export interface PackedMember {
  /** The npm package name. */
  readonly name: string;
  /** The packed version. */
  readonly version: string;
  /** The absolute tarball path. */
  readonly tarball: string;
  /** The packed `package/package.json`, as shipped. */
  readonly manifest: Readonly<Record<string, unknown>>;
}

/** The root inputs every member's build inherits. */
const ROOT_INPUTS = ['tsconfig.base.json', 'package.json', 'pnpm-lock.yaml'];

/** Every file under a directory, sorted, as paths relative to `base`. */
async function filesUnder(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(path, base));
    else if (entry.isFile()) out.push(relative(base, path));
  }
  return out.sort();
}

/**
 * The cache key for the current tree: a hash over every pack input's path and
 * bytes.
 *
 * @param root - The repository root
 * @param members - The member directories to pack
 * @param self - This script's own path, so a change to packing invalidates too
 * @returns A hex digest
 */
export async function packCacheKey(
  root: string,
  members: readonly string[],
  self: string,
): Promise<string> {
  const files: string[] = [...ROOT_INPUTS, relative(root, self)];
  for (const member of members) {
    files.push(...await filesUnder(join(root, member, 'src'), root));
    files.push(join(member, 'package.json'), join(member, 'tsconfig.json'));
  }
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(file).update('\0');
    try {
      hash.update(await fs.readFile(join(root, file)));
    } catch {
      hash.update('<absent>');
    }
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 24);
}

/**
 * The entrypoints a packed manifest names — every `exports` target and every
 * `bin` — which must exist inside the tarball.
 *
 * @param manifest - The packed `package.json`
 * @returns Package-relative paths, without a leading `./`
 */
export function packedEntrypoints(manifest: Readonly<Record<string, unknown>>): string[] {
  const out = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith('./')) out.add(value.slice(2));
    } else if (typeof value === 'object' && value !== null) {
      for (const inner of Object.values(value)) visit(inner);
    }
  };
  visit(manifest['exports']);
  visit(manifest['bin']);
  return [...out].sort();
}

/** Lists a tarball's file paths, relative to its `package/` directory. */
async function tarballFiles(tarball: string): Promise<Set<string>> {
  const { stdout } = await run('tar', ['-tzf', tarball], { maxBuffer: 64 * 1024 * 1024 });
  return new Set(
    stdout.split('\n').filter((line) => line.startsWith('package/')).map((line) =>
      line.slice('package/'.length)
    ),
  );
}

/** Reads the packed `package/package.json`. */
async function packedManifest(tarball: string): Promise<Record<string, unknown>> {
  const { stdout } = await run('tar', ['-xzOf', tarball, 'package/package.json'], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

/**
 * Builds the workspace and packs every published member, or returns the cached
 * packs for this tree.
 *
 * Requires an installed workspace (`pnpm install`); it builds with
 * `pnpm exec tsc -b`, packs each member with `pnpm pack --ignore-scripts`, and
 * refuses a pack missing any entrypoint its manifest names.
 *
 * @param root - The repository root (absolute)
 * @param members - The member directories; defaults to every published one
 * @returns The packed members, by package name
 */
export async function packMembers(
  root: string,
  members: readonly string[] = PUBLISHED_PACKAGES,
): Promise<ReadonlyMap<string, PackedMember>> {
  const self = new URL(import.meta.url).pathname;
  const key = await packCacheKey(root, members, self);
  const cacheDir = join(root, '.tmp', 'overlay', key);
  const index = join(cacheDir, 'packs.json');
  try {
    return toMap(JSON.parse(await fs.readFile(index, 'utf8')) as PackedMember[]);
  } catch {
    // Not built for this tree yet.
  }

  try {
    await fs.stat(join(root, 'node_modules'));
  } catch {
    throw new Error(`packMembers: ${root} is not installed; run \`pnpm install\` first.`);
  }

  // One builder per key: `tsc -b` writes every member's `dist/`, and two at once
  // race. `mkdir` is atomic, so exactly one caller holds the lock; the others
  // wait for the index it publishes.
  await fs.mkdir(join(root, '.tmp', 'overlay'), { recursive: true });
  const lock = `${cacheDir}.lock`;
  try {
    await fs.mkdir(lock);
  } catch {
    return await waitForIndex(index, lock);
  }
  try {
    return await build(root, members, cacheDir, index);
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

/** How long a waiting caller allows another's cold build to take. */
const BUILD_WAIT_MS = 15 * 60 * 1000;

/** Waits for another caller's build of the same key to publish its index. */
async function waitForIndex(index: string, lock: string): Promise<ReadonlyMap<string, PackedMember>> {
  const deadline = Date.now() + BUILD_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      return toMap(JSON.parse(await fs.readFile(index, 'utf8')) as PackedMember[]);
    } catch {
      try {
        await fs.stat(lock);
      } catch {
        throw new Error('packMembers: the build holding the lock ended without publishing packs.');
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`packMembers: timed out waiting for ${lock}`);
}

/** Builds and packs every member into a fresh cache directory. */
async function build(
  root: string,
  members: readonly string[],
  cacheDir: string,
  index: string,
): Promise<ReadonlyMap<string, PackedMember>> {
  await run('pnpm', ['exec', 'tsc', '-b'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });

  const staging = await fs.mkdtemp(join(root, '.tmp', 'overlay-staging-'));
  const packed: PackedMember[] = [];
  const refusals: string[] = [];
  for (const member of members) {
    const { stdout } = await run(
      'pnpm',
      ['pack', '--ignore-scripts', '--pack-destination', staging],
      { cwd: join(root, member), maxBuffer: 16 * 1024 * 1024 },
    );
    const tarballPath = stdout.trim().split('\n').reverse().find((line) => line.endsWith('.tgz'));
    if (tarballPath === undefined) {
      refusals.push(`${member}: pnpm pack reported no tarball`);
      continue;
    }
    const final = join(cacheDir, tarballPath.slice(staging.length + 1));
    const manifest = await packedManifest(tarballPath);
    const present = await tarballFiles(tarballPath);
    for (const entry of packedEntrypoints(manifest)) {
      if (!present.has(entry)) refusals.push(`${member}: packed manifest names ${entry}, absent`);
    }
    packed.push({
      name: String(manifest['name']),
      version: String(manifest['version']),
      tarball: final,
      manifest,
    });
  }
  if (refusals.length > 0) {
    await fs.rm(staging, { recursive: true, force: true });
    throw new Error(`packMembers refused:\n${refusals.join('\n')}`);
  }
  await fs.writeFile(join(staging, 'packs.json'), JSON.stringify(packed, null, 2));
  try {
    await fs.rename(staging, cacheDir);
  } catch {
    // Another caller published this key first; theirs is identical.
    await fs.rm(staging, { recursive: true, force: true });
  }
  return toMap(JSON.parse(await fs.readFile(index, 'utf8')) as PackedMember[]);
}

/** Indexes packs by name. */
function toMap(packs: readonly PackedMember[]): ReadonlyMap<string, PackedMember> {
  return new Map(packs.map((pack) => [pack.name, pack]));
}
