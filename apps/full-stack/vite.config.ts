import { readdirSync, readFileSync } from 'node:fs';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * Vite builds the client bundle and the server build; it does NOT serve the
 * application. The framework owns the server, so `vite build` is a build step
 * and `setu`/`main.ts` is the runtime.
 *
 * `resolve.tsconfigPaths` is what makes the `~/*` and `~kernel/*` aliases work at build time;
 * the same alias is declared in tsconfig.json for the type-checker.
 */
// Framework packages stay external, resolved by the server runtime. Bundling
// would inline a second copy: context keys in app/server/context-keys.server.ts
// match by identity, so a loader must share the instance setu.config.ts holds.
export const frameworkPackages = ['@setu-ts/react-router-plugin', '@setu-ts/common'];

// Workspace libraries are resolved by the server runtime, just like framework
// packages. Read each library's declared name: a custom scope is valid too.
export const workspaceLibraries: string[] = [];
try {
  const libraries = new URL('../../libs/', import.meta.url);
  for (const entry of readdirSync(libraries, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = readLibraryManifest(new URL(entry.name + '/', libraries));
      if (typeof manifest?.name === 'string') workspaceLibraries.push(manifest.name);
    } catch {
      // A directory without a readable library manifest contributes no name.
    }
  }
} catch {
  // Standalone projects and workspaces without libraries have no externals here.
}

/**
 * Reads a library's manifest: deno.json, then deno.jsonc (Deno), then package.json (Node and
 * Bun), so a library is kept external on every runtime.
 */
function readLibraryManifest(directory: URL): { name?: unknown } | undefined {
  for (const file of ['deno.json', 'deno.jsonc', 'package.json']) {
    let text: string;
    try {
      text = readFileSync(new URL(file, directory), 'utf8');
    } catch {
      continue;
    }
    return JSON.parse(stripJsonc(text));
  }
  return undefined;
}

/**
 * Drops JSONC comments, then trailing commas, leaving string contents untouched.
 * Each pass is linear: a comma looks ahead only across the whitespace after it.
 */
function stripJsonc(text: string): string {
  return dropTrailingCommas(dropComments(text));
}

/** Copies a string literal starting at `start`, returning the index after it. */
function skipString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
  return i + 1;
}

/** Removes line and block comments outside string literals. */
function dropComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      out += ' ';
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/** Removes a comma followed only by whitespace and a closing bracket. */
function dropTrailingCommas(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (text[i] === ',') {
      let next = i + 1;
      while (/\s/.test(text[next] ?? '')) next += 1;
      if (text[next] === '}' || text[next] === ']') {
        i += 1;
        continue;
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

// A declared package is external together with every exported subpath of it.
const isDeclared = (names: readonly string[], id: string): boolean =>
  names.some((name) => id === name || id.startsWith(name + '/'));

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: { tsconfigPaths: true },
  // Declared per environment: React Router builds through Vite's Environment
  // API, and neither a top-level `ssr.external` nor
  // `environments.ssr.resolve.external` is applied to that build.
  environments: {
    ssr: {
      build: {
        rollupOptions: {
          external: (id) => isDeclared(frameworkPackages, id) || isDeclared(workspaceLibraries, id),
        },
      },
    },
  },
});
