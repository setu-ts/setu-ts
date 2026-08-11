/**
 * The one edit a workspace root can need after it is created: enabling
 * `node_modules` for a member with a frontend build.
 *
 * A `full-stack` member carries a `package.json` and runs a real Vite build, and
 * that build resolves its own plugins from a `node_modules` directory on disk.
 * Deno accepts `nodeModulesDir` **only in the workspace root** — a member
 * declaring it is refused with `"nodeModulesDir" field can only be specified in
 * the workspace root deno.json file` — so the root has to carry it.
 *
 * **It is not emitted at creation time, and that was measured rather than
 * assumed.** With `nodeModulesDir: "auto"` at the root, `deno check` on an
 * ordinary `microservice` member materialises every npm package the framework
 * lazily imports into `node_modules` — the AWS SDK, the Kafka and Redis clients,
 * `nodemailer` — none of which that member uses at runtime. A workspace with no
 * frontend member would pay for all of it on its first type-check. So the field
 * arrives with the member that needs it, which makes this the one file
 * `generate app` may edit.
 *
 * The edit is a single-key merge on a file the CLI itself wrote, reported like
 * any other write, and it refuses rather than guesses whenever the root is not
 * plain JSON or already answers the question differently.
 *
 * @module
 */

import type { GeneratedFile } from '../utils/file-writer.ts';

/** The root manifest a Deno workspace is defined by. */
export const ROOT_MANIFEST = 'deno.json';

/** The field a frontend member needs the root to declare. */
export const NODE_MODULES_DIR = 'nodeModulesDir';

/**
 * The value that lets a member's npm toolchain work.
 *
 * `"auto"` rather than `"manual"`: Deno populates the directory from the
 * member's `package.json` itself, which is what `deno install` in that member
 * then extends. `"manual"` would require an npm client to have run first.
 */
export const NODE_MODULES_AUTO = 'auto';

/** What planning the root edit produced. */
export type RootManifestPlan =
  /** The root already allows it; nothing to write. */
  | { readonly kind: 'unchanged' }
  /** The root needs this file written in place of its current contents. */
  | { readonly kind: 'update'; readonly file: GeneratedFile }
  /** The root cannot be edited safely; print this and stop. */
  | { readonly kind: 'refused'; readonly message: string };

/**
 * Plans the root edit a frontend member needs.
 *
 * Rewrites the WHOLE manifest from its parsed form, which is why a root this
 * cannot parse is refused instead: reformatting is acceptable (the CLI wrote the
 * file and its shape is JSON), but silently discarding a comment or a trailing
 * field a developer added would not be.
 *
 * @param contents - The root manifest as it is on disk
 * @param member - The member whose build needs the field, named in refusals
 * @returns Whether to write, and what
 */
export function planRootNodeModulesDir(contents: string, member: string): RootManifestPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return {
      kind: 'refused',
      message:
        `Cannot read the workspace ${ROOT_MANIFEST} as JSON, and the "${member}" member needs ` +
        `\`"${NODE_MODULES_DIR}": "${NODE_MODULES_AUTO}"\` added to it for its frontend build. ` +
        `Add that field by hand and run this again — rewriting a file this cannot parse would ` +
        `discard whatever it holds.`,
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      kind: 'refused',
      message: `The workspace ${ROOT_MANIFEST} is not a JSON object, so there is nowhere to add ` +
        `\`"${NODE_MODULES_DIR}"\`, which the "${member}" member needs for its frontend build.`,
    };
  }

  const record = parsed as Record<string, unknown>;
  const current = record[NODE_MODULES_DIR];

  // Already answered, and answered the same way: nothing to do.
  if (current === NODE_MODULES_AUTO) return { kind: 'unchanged' };

  // Answered differently, and by a human — `none` in particular is a deliberate
  // choice to keep every dependency in Deno's global cache. Overwriting it would
  // reverse a decision without saying so.
  if (current !== undefined) {
    return {
      kind: 'refused',
      message: `The workspace ${ROOT_MANIFEST} sets "${NODE_MODULES_DIR}": ` +
        `${JSON.stringify(current)}, and the "${member}" member's frontend build needs ` +
        `"${NODE_MODULES_AUTO}" — its Vite build resolves plugins from a real node_modules ` +
        `directory. Change it there if that is what you want, then run this again.`,
    };
  }

  return {
    kind: 'update',
    file: {
      path: ROOT_MANIFEST,
      contents: `${
        JSON.stringify({ ...record, [NODE_MODULES_DIR]: NODE_MODULES_AUTO }, null, 2)
      }\n`,
      // The CLI wrote this file and is adding one field to it, so the overwrite
      // check must not treat it as somebody else's.
      managed: true,
    },
  };
}
