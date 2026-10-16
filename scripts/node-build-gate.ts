/**
 * The decidable half of the Node pack-and-boot gate (M111a plan §3.10).
 *
 * `scripts/check-node-build.ts` spawns pnpm, npm, Node and Bun; everything it
 * DECIDES lives here, pure, so it carries the per-file coverage bar through
 * `SCRIPT_TARGETS` while the orchestration stays out of it (the M39
 * `check-deploy.ts` precedent):
 *
 * - {@linkcode workspaceProtocolSpecifiers} — a packed manifest still naming
 *   `workspace:` installs for nobody, so any such field is a refusal;
 * - {@linkcode decideOutcome} — a leg whose runtime binary is absent is a
 *   reported skip (exit 77, the `check:apps` convention) unless the run passed
 *   `--require-all`, which CI does, so a skip can never read as a pass there.
 *
 * @module
 */

/** The dependency fields npm reads when installing a tarball. */
const SHIPPED_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;

/**
 * The workspace members excluded from the Workers bundle leg (M113d §3.4):
 * `setu` and `npm create @setu-ts` are executables, not libraries a Worker
 * imports, and neither ships a barrel a bundler could resolve.
 */
const WORKERS_BUNDLE_EXCLUDED: ReadonlySet<string> = new Set(['packages/cli', 'packages/create']);

/**
 * The published members the Workers bundle leg imports: every workspace
 * member except the two executables.
 *
 * @param members - The workspace member directories, in authored order
 * @returns The directories whose barrel the entry module imports
 */
export function workersBundleMembers(members: readonly string[]): readonly string[] {
  return members.filter((dir) => !WORKERS_BUNDLE_EXCLUDED.has(dir));
}

/**
 * The Workers bundle entry module: one side-effect import per member barrel.
 *
 * Resolution, not execution, is the point — Wrangler's esbuild pass fails a
 * Worker build on the first unresolvable specifier, so a bare `import()` a
 * guarded loader let through, or a regular dependency that does not resolve
 * for `workerd`, fails here.
 *
 * @param names - The npm package names whose barrel the entry imports
 * @returns The entry module source
 */
export function workersBundleEntry(names: readonly string[]): string {
  return `${names.map((name) => `import '${name}';`).join('\n')}\n`;
}

/** The esbuild option set the Workers bundle leg builds with. */
export interface WorkersBundleOptions {
  /** ESM, as a Worker entry is. */
  readonly format: 'esm';
  /** `neutral` — no Node or browser built-ins assumed. */
  readonly platform: 'neutral';
  /** Wrangler's resolution conditions, in its order. */
  readonly conditions: readonly string[];
  /** Wrangler's main-field priority. */
  readonly mainFields: readonly string[];
  /** Node built-ins and Cloudflare's platform modules stay runtime imports. */
  readonly external: readonly string[];
}

/**
 * The esbuild options matching Wrangler's bundling resolution (M113d §3.4):
 * the same conditions and main fields Wrangler passes, with `node:*` and
 * `cloudflare:*` left external as workerd supplies them at runtime.
 *
 * @returns The option object spread into the fixture's `build()` call
 */
export function workersBundleOptions(): WorkersBundleOptions {
  return {
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['browser', 'module', 'main'],
    external: ['node:*', 'cloudflare:*'],
  };
}

/**
 * Every `name@specifier` in a packed manifest's shipped dependency fields that
 * still uses the `workspace:` protocol.
 *
 * `devDependencies` are excluded: npm never installs them for a consumer, so a
 * `workspace:` left there is inert.
 *
 * @param manifest - The parsed `package.json` read out of a tarball
 * @returns The offending entries, empty when the manifest is installable
 */
export function workspaceProtocolSpecifiers(manifest: unknown): readonly string[] {
  if (typeof manifest !== 'object' || manifest === null) return [];
  const found: string[] = [];
  for (const field of SHIPPED_FIELDS) {
    const deps = (manifest as Record<string, unknown>)[field];
    if (typeof deps !== 'object' || deps === null) continue;
    for (const [name, specifier] of Object.entries(deps)) {
      if (typeof specifier === 'string' && specifier.startsWith('workspace:')) {
        found.push(`${field}: ${name}@${specifier}`);
      }
    }
  }
  return found;
}

/** One runtime leg of the boot. */
export interface LegResult {
  /** A human name, e.g. `node 24`. */
  readonly name: string;
  /** `skipped` only when the runtime binary is absent. */
  readonly status: 'passed' | 'failed' | 'skipped';
  /** What the leg printed or why it was skipped. */
  readonly detail: string;
}

/** The gate's exit decision. */
export interface GateOutcome {
  /** 0 pass, 1 failure, 77 a reported skip. */
  readonly code: 0 | 1 | 77;
  /** One line per leg plus a summary. */
  readonly lines: readonly string[];
}

/**
 * Decides the exit code from the legs' results.
 *
 * A failure always wins. A skip exits 77 — never 0, so an absent runtime is
 * never reported as a pass — and becomes a failure under `requireAll`.
 *
 * @param legs - Every leg's result, in run order
 * @param requireAll - Whether a skipped leg fails the run
 * @returns The exit code and the report
 */
export function decideOutcome(legs: readonly LegResult[], requireAll: boolean): GateOutcome {
  const lines = legs.map((leg) => `${leg.status.padEnd(7)} ${leg.name}: ${leg.detail}`);
  const failed = legs.filter((leg) => leg.status === 'failed').length;
  const skipped = legs.filter((leg) => leg.status === 'skipped').length;
  if (legs.length === 0) {
    return { code: 1, lines: [...lines, 'node-build FAILED: no leg ran.'] };
  }
  if (failed > 0) {
    return { code: 1, lines: [...lines, `node-build FAILED: ${failed} leg(s) failed.`] };
  }
  if (skipped > 0 && requireAll) {
    return {
      code: 1,
      lines: [...lines, `node-build FAILED: ${skipped} leg(s) skipped under --require-all.`],
    };
  }
  if (skipped > 0) {
    return { code: 77, lines: [...lines, `node-build SKIPPED: ${skipped} leg(s) had no runtime.`] };
  }
  return { code: 0, lines: [...lines, `node-build passed: ${legs.length} leg(s).`] };
}

/**
 * Classifies one leg's process result.
 *
 * Success is the boot script's own `BOOT-OK ` line, not the exit code alone: a
 * script that exits 0 without reaching its assertions has proven nothing.
 *
 * @param name - The leg's name
 * @param code - The process exit code
 * @param output - Everything the process printed
 * @returns The leg result
 */
export function classifyLeg(name: string, code: number, output: string): LegResult {
  const ok = output.split('\n').find((line) => line.startsWith('BOOT-OK '));
  if (code === 0 && ok !== undefined) return { name, status: 'passed', detail: ok };
  const tail = output.trim().split('\n').slice(-5).join(' | ');
  return { name, status: 'failed', detail: `exit ${code}: ${tail}` };
}
