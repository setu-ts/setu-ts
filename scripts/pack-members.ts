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
 * `package.json`, `tsconfig.json`, `README.md` and `LICENSE`, and the root inputs
 * every build inherits — `tsconfig.base.json`, the solution `tsconfig.json`, the
 * root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, the root
 * `LICENSE` and this script. A change to any of them is a new key, so a stale
 * pack is never served. A cache directory is published by an atomic rename, so a
 * caller either builds it or finds it complete, never half-written.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { hostname } from 'node:os';
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
const ROOT_INPUTS = [
  'tsconfig.base.json',
  'tsconfig.json',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'LICENSE',
];

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
    // Every file a tarball carries besides `dist/` (built from the inputs above)
    // and `src/`: an edited README or licence is a different tarball.
    files.push(
      join(member, 'package.json'),
      join(member, 'tsconfig.json'),
      join(member, 'README.md'),
      join(member, 'LICENSE'),
    );
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

/** How a {@linkcode packMembers} call reaches the outside world; for tests. */
export interface PackDeps {
  /** Runs a command; defaults to `execFile`. */
  readonly run?: (
    command: string,
    args: readonly string[],
    options: { cwd: string; maxBuffer: number },
  ) => Promise<{ stdout: string }>;
  /** Whether a process id on this host is alive; defaults to `process.kill(pid, 0)`. */
  readonly alive?: (pid: number) => boolean;
  /** The wall clock in milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Waits between polls; defaults to a timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** This host's name, recorded in the lock; defaults to `os.hostname()`. */
  readonly hostname?: string;
}

/**
 * Builds and packs every published member, or returns the packs a previous call
 * built for the same tree.
 *
 * Requires an installed workspace (`pnpm install`); it builds with
 * `pnpm exec tsc -b`, packs each member with `pnpm pack --ignore-scripts`, and
 * refuses a pack missing any entrypoint its manifest names.
 *
 * One build runs at a time per repository, whatever its key: `tsc -b` writes
 * every member's `dist/`, so two builds — even for different member lists —
 * would pack each other's half-written output. The lock records its owner; a
 * lock whose owner on this host is dead is reclaimed rather than waited on for
 * fifteen minutes, and a waiter re-reads the index before declaring failure,
 * since the builder publishes it and then removes the lock.
 *
 * @param root - The repository root (absolute)
 * @param members - The member directories; defaults to every published one
 * @param deps - Injection seams; for tests
 * @returns The packed members, by package name
 */
export async function packMembers(
  root: string,
  members: readonly string[] = PUBLISHED_PACKAGES,
  deps: PackDeps = {},
): Promise<ReadonlyMap<string, PackedMember>> {
  const self = new URL(import.meta.url).pathname;
  const key = await packCacheKey(root, members, self);
  const cacheDir = join(root, '.tmp', 'overlay', key);
  const index = join(cacheDir, 'packs.json');
  const cached = await readIndex(index);
  if (cached !== undefined) return cached;

  try {
    await fs.stat(join(root, 'node_modules'));
  } catch {
    throw new Error(`packMembers: ${root} is not installed; run \`pnpm install\` first.`);
  }

  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const host = deps.hostname ?? hostname();
  await fs.mkdir(join(root, '.tmp', 'overlay'), { recursive: true });
  const lock = join(root, '.tmp', 'overlay', 'build.lock');
  const deadline = now() + BUILD_WAIT_MS;
  for (;;) {
    if (await acquireLock(lock, host, now())) {
      try {
        // Built while this caller waited for the lock.
        const done = await readIndex(index);
        if (done !== undefined) return done;
        return await build(root, members, cacheDir, index, deps.run ?? defaultRun);
      } finally {
        await fs.rm(lock, { recursive: true, force: true });
      }
    }
    if (await lockIsStale(lock, host, now(), deps.alive ?? processAlive)) {
      await reclaimLock(lock);
      continue;
    }
    const done = await readIndex(index);
    if (done !== undefined) return done;
    if (now() > deadline) throw new Error(`packMembers: timed out waiting for ${lock}`);
    await sleep(500);
  }
}

/** How long a waiting caller allows another's cold build to take. */
const BUILD_WAIT_MS = 15 * 60 * 1000;

/**
 * How long a lock may exist without an owner record before it is presumed
 * abandoned: the owner writes the record immediately after creating the lock, so
 * only a crash in between leaves one without it.
 */
const OWNERLESS_GRACE_MS = 60 * 1000;

/** The owner a lock records. */
interface LockOwner {
  readonly pid: number;
  readonly hostname: string;
  readonly since: number;
}

/** Runs a command through `execFile`. */
const defaultRun: NonNullable<PackDeps['run']> = (command, args, options) =>
  run(command, [...args], options);

/** Whether a process on this host is alive. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: it exists, owned by someone else.
    return (cause as { code?: unknown }).code === 'EPERM';
  }
}

/** Reads a published index, or `undefined` when there is none yet. */
async function readIndex(index: string): Promise<ReadonlyMap<string, PackedMember> | undefined> {
  try {
    return toMap(JSON.parse(await fs.readFile(index, 'utf8')) as PackedMember[]);
  } catch {
    return undefined;
  }
}

/**
 * Takes the build lock: `mkdir` is atomic, so exactly one caller succeeds.
 *
 * @returns Whether this caller now holds it
 */
export async function acquireLock(lock: string, host: string, since: number): Promise<boolean> {
  try {
    await fs.mkdir(lock);
  } catch {
    return false;
  }
  const owner: LockOwner = { pid: process.pid, hostname: host, since };
  await fs.writeFile(join(lock, 'owner.json'), JSON.stringify(owner));
  return true;
}

/**
 * Whether a held lock was abandoned: its owner is a dead process on this host,
 * or it has carried no owner record for longer than a crash between creating it
 * and recording one could explain. A lock owned on another host is never
 * presumed dead — this host cannot ask.
 */
export async function lockIsStale(
  lock: string,
  host: string,
  now: number,
  alive: (pid: number) => boolean,
): Promise<boolean> {
  let owner: LockOwner;
  try {
    owner = JSON.parse(await fs.readFile(join(lock, 'owner.json'), 'utf8')) as LockOwner;
  } catch {
    try {
      const stat = await fs.stat(lock);
      return now - stat.mtimeMs > OWNERLESS_GRACE_MS;
    } catch {
      return false; // Released in the meantime: not stale, simply gone.
    }
  }
  return owner.hostname === host && typeof owner.pid === 'number' && !alive(owner.pid);
}

/**
 * Removes an abandoned lock. Renamed aside first, so two callers reclaiming the
 * same lock cannot remove a fresh one the other has just taken: only one rename
 * of a given directory succeeds.
 */
async function reclaimLock(lock: string): Promise<void> {
  const aside = `${lock}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await fs.rename(lock, aside);
  } catch {
    return; // Another caller reclaimed it first.
  }
  await fs.rm(aside, { recursive: true, force: true });
}

/** Builds and packs every member into a fresh cache directory. */
async function build(
  root: string,
  members: readonly string[],
  cacheDir: string,
  index: string,
  exec: NonNullable<PackDeps['run']>,
): Promise<ReadonlyMap<string, PackedMember>> {
  await exec('pnpm', ['exec', 'tsc', '-b'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });

  const staging = await fs.mkdtemp(join(root, '.tmp', 'overlay-staging-'));
  let published = false;
  try {
    const packed: PackedMember[] = [];
    const refusals: string[] = [];
    for (const member of members) {
      const { stdout } = await exec(
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
    if (refusals.length > 0) throw new Error(`packMembers refused:\n${refusals.join('\n')}`);
    await fs.writeFile(join(staging, 'packs.json'), JSON.stringify(packed, null, 2));
    await fs.rename(staging, cacheDir);
    published = true;
  } finally {
    // Whatever failed — a pack, an extraction, a refusal, the publish itself —
    // the staging directory is this call's, and nothing else will remove it.
    if (!published) await fs.rm(staging, { recursive: true, force: true });
  }
  return (await readIndex(index))!;
}

/** Indexes packs by name. */
function toMap(packs: readonly PackedMember[]): ReadonlyMap<string, PackedMember> {
  return new Map(packs.map((pack) => [pack.name, pack]));
}
