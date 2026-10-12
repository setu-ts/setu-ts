/**
 * A local npm registry that serves this tree's own `@setu-ts/*` packs and
 * proxies everything else to the public registry.
 *
 * Nothing is on npm until the `v0.9.0` cut, and a scaffold pins the CLI's own
 * version, so every gate that installs a generated project resolves the
 * framework here instead. Installers are pointed at it through the environment
 * alone (`NPM_CONFIG_REGISTRY`, which npm, Deno and Bun all honour — probed
 * 2026-10-12), so no generated file changes. It always serves the tree's own
 * version, so a version bump cannot deadlock a gate against the publish that
 * would satisfy it (M34b).
 *
 * Built on `node:` APIs only, so Vitest on Node and Deno scripts share it.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename } from 'node:path';
import { type PackedMember, packMembers } from './pack-members.ts';

/** The public registry every other request is forwarded to. */
export const UPSTREAM_REGISTRY = 'https://registry.npmjs.org';

/** The URL prefix the overlay's own tarballs are served under. */
const TARBALL_PREFIX = '/-/setu-overlay/';

/**
 * The publication time packuments report by default: old enough that no
 * `minimumDependencyAge` a template emits ever refuses it.
 */
export const DEFAULT_PUBLISHED_AT = '2020-01-01T00:00:00.000Z';

/** How the overlay is configured. */
export interface RegistryOverlayOptions {
  /** The packs to serve; built from the tree when omitted. */
  readonly packs?: ReadonlyMap<string, PackedMember>;
  /** The repository root the packs are built from, when `packs` is omitted. */
  readonly root?: string;
  /** `'now'` stamps packuments with the current time instead of the default. */
  readonly publishedAt?: 'default' | 'now';
  /** The registry everything else is forwarded to. */
  readonly upstream?: string;
  /** Replaces `fetch` for the upstream proxy; for tests. */
  readonly fetch?: typeof fetch;
}

/** A running overlay. */
export interface RegistryOverlay {
  /** The base URL to set as `NPM_CONFIG_REGISTRY`, with a trailing slash. */
  readonly url: string;
  /** The packs it serves, by package name. */
  readonly packs: ReadonlyMap<string, PackedMember>;
  /** Stops listening. */
  close(): Promise<void>;
}

/** The integrity fields npm checks a tarball against. */
interface Integrity {
  readonly shasum: string;
  readonly integrity: string;
}

/**
 * Builds the packument for one served package.
 *
 * @param pack - The packed member
 * @param base - The overlay's base URL
 * @param digest - The tarball's integrity fields
 * @param time - The publication time to report
 * @returns The packument document
 */
export function packument(
  pack: PackedMember,
  base: string,
  digest: Integrity,
  time: string,
): Record<string, unknown> {
  return {
    name: pack.name,
    'dist-tags': { latest: pack.version },
    versions: {
      [pack.version]: {
        ...pack.manifest,
        dist: {
          tarball: `${base}${TARBALL_PREFIX.slice(1)}${basename(pack.tarball)}`,
          ...digest,
        },
      },
    },
    time: { created: time, modified: time, [pack.version]: time },
  };
}

/**
 * The package a registry request path names, decoding the scoped `%2f` form.
 *
 * @param path - The request path, without query
 * @returns The package name, or `undefined` for any other request
 */
export function requestedPackage(path: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path.slice(1));
  } catch {
    return undefined;
  }
  return /^@setu-ts\/[a-z0-9-]+$/.test(decoded) ? decoded : undefined;
}

/**
 * Starts the overlay on an ephemeral `127.0.0.1` port.
 *
 * @param options - The packs, the publication time and the upstream
 * @returns The running overlay
 */
export async function startRegistryOverlay(
  options: RegistryOverlayOptions = {},
): Promise<RegistryOverlay> {
  const packs = options.packs ?? await packMembers(options.root ?? process.cwd());
  const upstream = options.upstream ?? UPSTREAM_REGISTRY;
  const doFetch = options.fetch ?? fetch;
  const time = options.publishedAt === 'now' ? new Date().toISOString() : DEFAULT_PUBLISHED_AT;

  const byTarball = new Map<string, PackedMember>();
  const digests = new Map<string, Integrity>();
  for (const pack of packs.values()) {
    const bytes = await fs.readFile(pack.tarball);
    byTarball.set(basename(pack.tarball), pack);
    digests.set(pack.name, {
      shasum: createHash('sha1').update(bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    });
  }

  let base = '';
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const name = requestedPackage(path);
    if (name !== undefined) {
      const pack = packs.get(name);
      if (pack !== undefined) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(packument(pack, base, digests.get(name)!, time)));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `${name} is not served by this overlay` }));
      return;
    }
    if (path.startsWith(TARBALL_PREFIX)) {
      // Only a tarball the overlay itself packed is ever read from disk: the
      // name is looked up, never joined onto a path.
      const pack = byTarball.get(path.slice(TARBALL_PREFIX.length));
      if (pack === undefined) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/octet-stream');
      res.end(await fs.readFile(pack.tarball));
      return;
    }
    const forwarded = await doFetch(`${upstream}${req.url ?? '/'}`, {
      headers: { accept: req.headers.accept ?? 'application/json' },
    });
    res.statusCode = forwarded.status;
    res.setHeader('content-type', forwarded.headers.get('content-type') ?? 'application/octet-stream');
    res.end(Buffer.from(await forwarded.arrayBuffer()));
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((cause: unknown) => {
      res.statusCode = 502;
      res.end(`registry overlay: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  });
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  base = `http://127.0.0.1:${port}/`;
  return {
    url: base,
    packs,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
