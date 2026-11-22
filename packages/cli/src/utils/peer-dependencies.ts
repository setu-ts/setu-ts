/** Runtime peer recording shared by add and generated workspace members. @module */
import type { IFileSystem } from '@setu-ts/common';
import { readWorkspaceManifest, MEMBERS_DIR, type WorkspaceMember } from '../workspace/manifest.ts';
import { workspaceProfile } from '../workspace/runtime-profile.ts';
import { joinPath, readExistingText } from './file-writer.ts';
import { escapeName } from './names.ts';

/** One root override that pins a package itself. */
interface IRootOverride {
  /** The spec the override names (a string value, or an object's `"."` entry). */
  readonly spec: string;
  /**
   * Whether the override is conditional: its key carried a version selector
   * (`ioredis@5`), or the package has more than one rule. It then applies only
   * to matching versions, which this command cannot evaluate.
   */
  readonly selector: boolean;
}

/**
 * The root overrides in a manifest's npm `overrides` that pin packages
 * THEMSELVES, at its top level, keyed by package name with any `@<range>`
 * selector on a key removed (`ioredis@5` → `ioredis`). A string value is the
 * spec; an object value pins the package only through its `"."` entry — an
 * object without one overrides the package's children, not the package, so it
 * is not returned.
 *
 * @param source - The root `package.json` text
 * @returns Each pinned package's override
 * @throws {SyntaxError} When the text is not JSON
 */
function rootOverrides(source: string): ReadonlyMap<string, IRootOverride> {
  const overrides = (JSON.parse(source) as { overrides?: unknown }).overrides;
  const pinned = new Map<string, IRootOverride>();
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides))
    return pinned;
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    const spec =
      typeof value === 'string'
        ? value
        : value !== null && typeof value === 'object' && Object.hasOwn(value, '.')
          ? (value as Record<string, unknown>)['.']
          : undefined;
    if (typeof spec !== 'string') continue;
    const at = key.indexOf('@', key.startsWith('@') ? 1 : 0);
    const name = at === -1 ? key : key.slice(0, at);
    // npm applies the first rule that matches the chosen version, so several
    // rules for one package (`x@1` and `x@2`, or `x` beside `x@2`) cannot be
    // reduced to one spec here: the name is treated as conditional.
    pinned.set(name, { spec, selector: at !== -1 || pinned.has(name) });
  }
  return pinned;
}

/**
 * The npm sections a production install keeps (`npm install --omit=dev` drops
 * `devDependencies`, not these), any of which means a peer is already declared.
 * `peerDependencies` is one: measured with npm 11 and Bun 1.4, both install a
 * project's own peer entry, so a second entry beside it would replace its pin.
 */
const PRODUCTION_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

/**
 * Validates the original manifest before a dependency merge can normalize it.
 *
 * @param source - Original JSON text from the caller-owned manifest
 * @param section - Dependency map the caller will rewrite
 * @returns The unchanged parsed object
 * @throws {Error} If the object or a dependency map has an invalid structure
 */
export function readDependencyManifest(source: string, section: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(source);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Manifest must be a JSON object.');
  const manifest = parsed as Record<string, unknown>;
  for (const name of section === 'imports'
    ? ['imports']
    : [...PRODUCTION_SECTIONS, 'devDependencies', section]) {
    const value = manifest[name];
    if (
      value !== undefined &&
      (value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.values(value).some((pin) => typeof pin !== 'string'))
    ) {
      throw new Error(`Manifest ${name} must be an object of dependency names and string specs.`);
    }
  }
  return manifest;
}

/**
 * The names a `package.json` already declares in a section a production install
 * keeps. Measured with npm 11: a root listing a package in `devDependencies` at
 * one version and in `dependencies` at another installs the `devDependencies`
 * version, so a second entry beside an existing one changes nothing; a peer
 * declared only in `devDependencies` is instead MOVED to `dependencies` by
 * {@linkcode withPeerDependencies}, because `--omit=dev` would drop it.
 *
 * @param parsed - The parsed manifest
 * @returns The declared names
 */
function declaredNames(parsed: Record<string, unknown>): ReadonlySet<string> {
  const names = new Set<string>();
  const optional = optionalPeerPins(parsed);
  for (const section of PRODUCTION_SECTIONS) {
    const entries = parsed[section];
    if (entries !== null && typeof entries === 'object' && !Array.isArray(entries)) {
      for (const name of Object.keys(entries)) {
        // An optional peer installs nothing (measured: npm 11 and Bun 1.4), so
        // it is not a declaration of an installed package.
        if (section === 'peerDependencies' && optional.has(name)) continue;
        names.add(name);
      }
    }
  }
  return names;
}

/**
 * The `peerDependencies` entries `peerDependenciesMeta` marks optional, with
 * their specs. Measured with npm 11 and Bun 1.4: neither installs such a peer,
 * so a runtime peer declared only this way is added to `dependencies` at the
 * declared spec, leaving the peer declaration as it is.
 *
 * @param parsed - The parsed manifest
 * @returns Each optional peer and its declared spec
 */
function optionalPeerPins(parsed: Record<string, unknown>): ReadonlyMap<string, string> {
  const peers = parsed['peerDependencies'];
  const meta = parsed['peerDependenciesMeta'];
  const pins = new Map<string, string>();
  if (peers === null || typeof peers !== 'object' || Array.isArray(peers)) return pins;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return pins;
  for (const [name, spec] of Object.entries(peers as Record<string, unknown>)) {
    const entry = (meta as Record<string, unknown>)[name];
    const isOptional =
      entry !== null &&
      typeof entry === 'object' &&
      (entry as Record<string, unknown>)['optional'] === true;
    if (isOptional && typeof spec === 'string') pins.set(name, spec);
  }
  return pins;
}

/** Every npm section a workspace member can pin a package in. */
const PIN_SECTIONS = [...PRODUCTION_SECTIONS, 'devDependencies'] as const;

/** One existing pin of a package somewhere in the workspace. */
interface IWorkspacePin {
  /** The manifest that pins it. */
  readonly path: string;
  /** The spec it is pinned at. */
  readonly spec: string;
}

/**
 * The pins the workspace's members already hold for the given packages, in any
 * section, read before this command writes anything. A member whose manifest
 * cannot be read is skipped: it cannot conflict with what npm will not install.
 *
 * @param fs - The filesystem to read through
 * @param root - The workspace root
 * @param members - The workspace's members
 * @param names - The package names to look for
 * @returns Each package's existing pins
 */
async function workspacePins(
  fs: IFileSystem,
  root: string,
  members: readonly WorkspaceMember[],
  names: ReadonlySet<string>,
): Promise<ReadonlyMap<string, readonly IWorkspacePin[]>> {
  const pins = new Map<string, IWorkspacePin[]>();
  for (const member of members) {
    const path = joinPath(root, joinPath(MEMBERS_DIR, joinPath(member.name, 'package.json')));
    let parsed: Record<string, unknown>;
    try {
      const text = await readExistingText(fs, path);
      if (text === undefined) continue;
      parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const section of PIN_SECTIONS) {
      const entries = parsed[section];
      if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) continue;
      for (const [name, spec] of Object.entries(entries as Record<string, unknown>)) {
        if (!names.has(name) || typeof spec !== 'string') continue;
        pins.set(name, [...(pins.get(name) ?? []), { path, spec }]);
      }
    }
  }
  return pins;
}

/**
 * Adds optional peer packages to a manifest's `dependencies`, never replacing
 * an existing pin.
 *
 * `setu add websocket` on Node must install `ws` — an optional peer of
 * `@setu-ts/runtime` that a package manager will not install for the consumer —
 * or the first upgrade answers 500 with nothing in the log. A peer already
 * pinned at any range is left exactly as it is: a hand-pinned version may be
 * deliberate, and this command cannot know why.
 *
 * @param source - The manifest's current contents
 * @param peers - Each peer and the range to record for it
 * @returns The rewritten manifest and the peers actually added
 */
export function withPeerDependencies(
  source: string,
  peers: readonly { readonly name: string; readonly range: string }[],
  section: 'dependencies' | 'imports',
): {
  readonly contents: string;
  readonly added: readonly string[];
  readonly moved: readonly string[];
} {
  if (peers.length === 0) return { contents: source, added: [], moved: [] };
  const parsed = readDependencyManifest(source, section);
  const existing = parsed[section];
  const dependencies =
    existing !== null && typeof existing === 'object'
      ? { ...(existing as Record<string, string>) }
      : {};
  const declared = section === 'dependencies' ? declaredNames(parsed) : new Set<string>();
  const optionalPins = optionalPeerPins(parsed);
  const devSection = parsed['devDependencies'];
  const dev =
    section === 'dependencies' &&
    devSection !== null &&
    typeof devSection === 'object' &&
    !Array.isArray(devSection)
      ? { ...(devSection as Record<string, string>) }
      : undefined;
  const added: string[] = [];
  const moved: string[] = [];
  for (const peer of peers) {
    if (peer.name in dependencies || declared.has(peer.name)) continue;
    const optionalPin = section === 'dependencies' ? optionalPins.get(peer.name) : undefined;
    const devPin = dev?.[peer.name];
    if (dev !== undefined && typeof devPin === 'string') {
      // A runtime peer declared for development, optional peer or not: `--omit=dev`
      // would drop it, so its existing pin moves to `dependencies` unchanged.
      dependencies[peer.name] = devPin;
      delete dev[peer.name];
      moved.push(peer.name);
      continue;
    }
    if (optionalPin !== undefined) {
      dependencies[peer.name] = optionalPin;
      added.push(peer.name);
      continue;
    }
    dependencies[peer.name] = section === 'imports' ? `npm:${peer.name}@${peer.range}` : peer.range;
    added.push(peer.name);
  }
  if (added.length === 0 && moved.length === 0) return { contents: source, added: [], moved: [] };
  const rewritten: Record<string, unknown> = { ...parsed, [section]: dependencies };
  if (moved.length > 0) rewritten['devDependencies'] = dev;
  return { contents: `${JSON.stringify(rewritten, null, 2)}\n`, added, moved };
}

/**
 * Plans runtime peers beside a workspace's hoisted framework packages.
 *
 * Existing pins and root overrides keep their specs; conditional overrides are
 * named and left to the developer. No files are written by this planner.
 *
 * @param fs - Filesystem used to read root and member manifests
 * @param root - The workspace root
 * @param peerPackages - Runtime peers and their compatible ranges
 * @param log - Reports override decisions and differing member pins
 * @returns The root edit and affected peer names, or no edit
 * @throws {Error} When an existing root manifest cannot be read or parsed
 */
export async function planWorkspacePeers(
  fs: IFileSystem,
  root: string,
  peerPackages: readonly { readonly name: string; readonly range: string }[],
  log: (line: string) => void,
): Promise<
  | {
      readonly path: string;
      readonly contents: string;
      readonly added: readonly string[];
      readonly moved: readonly string[];
    }
  | undefined
> {
  if (peerPackages.length === 0) return undefined;
  const workspace = await readWorkspaceManifest(fs, root);
  if (!workspace.ok || workspaceProfile(workspace.manifest.runtime).manifestKind !== 'npm')
    return undefined;
  const path = joinPath(root, 'package.json');
  // A leading BOM is valid to npm and Bun alike; JSON.parse refuses it.
  const source = (await readExistingText(fs, path))?.replace(/^\uFEFF/, '');
  if (source !== undefined) {
    // npm refuses (EOVERRIDE) a direct dependency whose spec differs from
    // a root override of the same package, and an override alone installs
    // nothing. So a peer the root overrides is recorded at the override's
    // own spec; a `$name` reference is not a spec a dependency can carry,
    // so that peer is left to the override and the reason printed.
    const overridden = rootOverrides(source);
    const parsedRoot = readDependencyManifest(source, 'dependencies');
    const devRoot = parsedRoot['devDependencies'];
    // An existing pin in any section wins over the override logic: a
    // production one is kept, a development one is moved as it stands, and
    // an optional peer's spec is added to `dependencies` beside it.
    const declared = new Set([
      ...declaredNames(parsedRoot),
      ...(devRoot !== null && typeof devRoot === 'object' && !Array.isArray(devRoot)
        ? Object.keys(devRoot)
        : []),
      ...optionalPeerPins(parsedRoot).keys(),
    ]);
    const pinned = await workspacePins(
      fs,
      root,
      workspace.manifest.members,
      new Set(peerPackages.map((peer) => peer.name)),
    );
    const rootPeers: { readonly name: string; readonly range: string }[] = [];
    for (const peer of peerPackages) {
      const override = overridden.get(peer.name);
      if (declared.has(peer.name)) {
        rootPeers.push(peer);
      } else if (override?.selector === true) {
        // Whether `name@<range>` applies depends on the version npm picks,
        // which this command cannot evaluate: either spec can be refused.
        log(
          `left ${peer.name} out of ${escapeName(path)}: its "overrides" pins it only for ` +
            `some versions; add it at the root yourself, at a spec that agrees with that override.`,
        );
      } else if (override?.spec.startsWith('$') === true) {
        log(
          `left ${peer.name} out of ${escapeName(path)}: its "overrides" pins it by reference ` +
            `(${escapeName(override.spec)}); add the referenced dependency at the root yourself.`,
        );
      } else if (override !== undefined) {
        rootPeers.push({ name: peer.name, range: override.spec });
      } else {
        // The root entry is what places a version inside the framework's
        // peer range where the hoisted framework package resolves it; without
        // one, placement is npm's choice, and V10-50's image (installed from a
        // lockfile recording the peer nested under a member) crashed on it. A
        // member pinned at another spec may then keep a second copy — measured
        // with npm 11: root 5.11.1 beside a nested 5.4.1 — so it is named.
        rootPeers.push(peer);
        const differing = (pinned.get(peer.name) ?? []).filter((pin) => pin.spec !== peer.range);
        if (differing.length > 0) {
          log(
            `note: ${differing
              .map((pin) => `${escapeName(pin.path)} pins ${peer.name} at ${escapeName(pin.spec)}`)
              .join('; ')}; the root entry keeps the hoisted framework package on ` +
              `${escapeName(peer.range)}, and npm may install a second copy for that member — ` +
              `align the pins if they should share one.`,
          );
        }
      }
    }
    const merged = withPeerDependencies(source, rootPeers, 'dependencies');
    if (merged.added.length > 0 || merged.moved.length > 0) {
      return { path, contents: merged.contents, added: merged.added, moved: merged.moved };
    }
  }

  return undefined;
}
