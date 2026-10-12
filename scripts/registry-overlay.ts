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
import type { AddressInfo } from 'node:net';
import { type PackedMember, packMembers } from './pack-members.ts';

/** The public registry every other request is forwarded to. */
export const UPSTREAM_REGISTRY = 'https://registry.npmjs.org';

/**
 * The publication time packuments report by default: old enough that no
 * `minimumDependencyAge` a template emits ever refuses it.
 */
export const DEFAULT_PUBLISHED_AT = '2020-01-01T00:00:00.000Z';

/**
 * How the overlay is configured: the packs to serve, or the repository root to
 * build them from.
 */
export type RegistryOverlayOptions =
  & OverlaySettings
  & (
    | { readonly packs: ReadonlyMap<string, PackedMember> }
    | { readonly root: string }
  );

/** The settings every overlay takes. */
export interface OverlaySettings {
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
          tarball: `${base}${tarballPath(pack.name, pack.version).slice(1)}`,
          ...digest,
        },
      },
    },
    time: { created: time, modified: time, [pack.version]: time },
  };
}

/**
 * The canonical registry path of a package version's tarball — the route the
 * public registry uses, `/@scope/name/-/name-version.tgz`. Advertising it rather
 * than a private route means a lockfile resolved here names the same path a
 * lockfile resolved against npm does, and the overlay serves both.
 *
 * @param name - The scoped package name
 * @param version - The version
 * @returns The request path
 */
export function tarballPath(name: string, version: string): string {
  return `/${name}/-/${name.slice(name.indexOf('/') + 1)}-${version}.tgz`;
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

/** A request path with `%2f` and the like decoded, or as sent when malformed. */
function decodedPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Starts the overlay on an ephemeral `127.0.0.1` port.
 *
 * @param options - The packs, the publication time and the upstream
 * @returns The running overlay
 */
export async function startRegistryOverlay(
  options: RegistryOverlayOptions,
): Promise<RegistryOverlay> {
  const packs = 'packs' in options ? options.packs : await packMembers(options.root);
  const upstream = options.upstream ?? UPSTREAM_REGISTRY;
  const doFetch = options.fetch ?? fetch;
  const time = options.publishedAt === 'now' ? new Date().toISOString() : DEFAULT_PUBLISHED_AT;

  const byTarball = new Map<string, PackedMember>();
  const digests = new Map<string, Integrity>();
  for (const pack of packs.values()) {
    const bytes = await fs.readFile(pack.tarball);
    byTarball.set(tarballPath(pack.name, pack.version), pack);
    digests.set(pack.name, {
      shasum: createHash('sha1').update(bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    });
  }

  let base = '';
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Always set on a request a server receives; typed optional for clients.
    const url = String(req.url);
    const path = url.replace(/\?.*$/s, '');
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
    // Only a tarball the overlay itself packed is ever read from disk: the
    // request path is looked up, never joined onto a filesystem path. Any other
    // version of a framework package is the public registry's to serve.
    const pack = byTarball.get(decodedPath(path));
    if (pack !== undefined) {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(await fs.readFile(pack.tarball));
      return;
    }
    const forwarded = await doFetch(`${upstream}${url}`, {
      headers: { accept: req.headers.accept ?? 'application/json' },
    });
    res.statusCode = forwarded.status;
    res.setHeader(
      'content-type',
      forwarded.headers.get('content-type') ?? 'application/octet-stream',
    );
    res.end(Buffer.from(await forwarded.arrayBuffer()));
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((cause: unknown) => {
      res.statusCode = 502;
      res.end(`registry overlay: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  });
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  // A listening TCP server always reports an address object.
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return {
    url: base,
    packs,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
