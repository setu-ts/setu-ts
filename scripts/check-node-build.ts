// deno-lint-ignore-file no-console -- a gate script reports to the console.
/**
 * The Node pack-and-boot gate (M111a plan §3.10).
 *
 * 1. `pnpm install --frozen-lockfile`, then one `tsc -b` over the solution
 *    `tsconfig.json` (a single process orders every project reference; a
 *    parallel `pnpm -r build` would race members building shared references).
 * 2. `pnpm pack` every member into `.tmp/node-pack/` and refuse any tarball
 *    whose shipped dependency fields still name `workspace:`.
 * 3. In an empty project, a PLAIN `npm install` (deliberately not pnpm — it is
 *    the repository's tool, not the consumer's) of all 52
 *    release members, each imported and checked for an exported surface.
 * 4. Compile the fixture's decorated controller with the repository's `tsc`
 *    and run `scripts/fixtures/node-boot/boot.mjs` on Node 24, Node 22 and
 *    Bun: each must serve a JSON route and the decorated controller.
 *
 * A leg whose runtime is absent is skipped and the run exits 77;
 * `--require-all` (CI) makes that a failure. The decisions are in
 * `node-build-gate.ts`; this file only spawns.
 *
 * Usage:
 *   deno task check:node-build [--require-all]
 *
 * @module
 */
import {
  classifyLeg,
  decideOutcome,
  type LegResult,
  workspaceProtocolSpecifiers,
} from './node-build-gate.ts';

const PACK_DIR = '.tmp/node-pack';
const BOOT_DIR = '.tmp/node-boot';

/** Runs a command, returning its exit code and combined output. */
async function run(
  cmd: string,
  args: readonly string[],
  cwd = '.',
): Promise<{ code: number; output: string }> {
  const { code, stdout, stderr } = await new Deno.Command(cmd, {
    args: [...args],
    cwd,
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  return { code, output: `${decode(stdout)}${decode(stderr)}` };
}

/** Runs a required step; any failure ends the gate with exit 1. */
async function step(label: string, cmd: string, args: readonly string[], cwd = '.') {
  const result = await run(cmd, args, cwd);
  if (result.code !== 0) {
    console.error(`✗ ${label} failed (exit ${result.code}):\n${result.output}`);
    Deno.exit(1);
  }
  console.log(`✓ ${label}`);
  return result;
}

/** Whether a binary can be spawned at all. */
async function available(cmd: string, args: readonly string[]): Promise<boolean> {
  try {
    return (await run(cmd, args)).code === 0;
  } catch {
    return false;
  }
}

/** A loopback port nothing is listening on. */
function freePort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

const requireAll = Deno.args.includes('--require-all');
const root = JSON.parse(await Deno.readTextFile('package.json')) as { workspaces: string[] };

await step('pnpm install --frozen-lockfile', 'pnpm', ['install', '--frozen-lockfile']);
await step('tsc -b (solution build)', 'pnpm', ['exec', 'tsc', '-b']);

await Deno.remove(PACK_DIR, { recursive: true }).catch(() => {});
await Deno.mkdir(PACK_DIR, { recursive: true });
const packDir = await Deno.realPath(PACK_DIR);
const tarballOf = new Map<string, string>();
const refusals: string[] = [];
for (const dir of root.workspaces) {
  const manifest = JSON.parse(await Deno.readTextFile(`${dir}/package.json`)) as {
    name: string;
    dependencies?: Record<string, string>;
  };
  const packed = await step(`pack ${manifest.name}`, 'pnpm', [
    'pack',
    '--ignore-scripts',
    '--pack-destination',
    packDir,
  ], dir);
  const tarball = packed.output.trim().split('\n').reverse().find((line) => line.endsWith('.tgz'));
  if (tarball === undefined) {
    refusals.push(`${manifest.name}: pnpm pack reported no tarball`);
    continue;
  }
  tarballOf.set(manifest.name, tarball);
  const inside = await run('tar', ['-xzOf', tarball, 'package/package.json']);
  for (const hit of workspaceProtocolSpecifiers(JSON.parse(inside.output))) {
    refusals.push(`${manifest.name}: packed manifest still carries ${hit}`);
  }
}
if (refusals.length > 0) {
  for (const refusal of refusals) console.error(`✗ ${refusal}`);
  Deno.exit(1);
}

const closure = [...tarballOf.keys()];
await Deno.remove(BOOT_DIR, { recursive: true }).catch(() => {});
await Deno.mkdir(BOOT_DIR, { recursive: true });
for await (const entry of Deno.readDir('scripts/fixtures/node-boot')) {
  await Deno.copyFile(`scripts/fixtures/node-boot/${entry.name}`, `${BOOT_DIR}/${entry.name}`);
}
await step(
  `npm install ${closure.join(' ')}`,
  'npm',
  ['install', '--no-audit', '--no-fund', ...closure.map((name) => tarballOf.get(name) as string)],
  BOOT_DIR,
);
// The repository's pinned compiler, run through `node` so the run permission
// stays scoped by command name rather than by a resolved `.bin` path.
const tsc = await Deno.realPath('node_modules/typescript/bin/tsc');
await step('tsc the decorated controller', 'node', [tsc, '-p', 'tsconfig.json'], BOOT_DIR);

const legs: LegResult[] = [];
const runLeg = async (name: string, cmd: string, args: readonly string[], probe: string[]) => {
  if (!(await available(cmd, probe))) {
    legs.push({ name, status: 'skipped', detail: `${cmd} is not available` });
    return;
  }
  const { code, output } = await run(cmd, [...args, 'boot.mjs', String(freePort())], BOOT_DIR);
  legs.push(classifyLeg(name, code, output));
};
await runLeg('node 24', 'node', [], ['--version']);
await runLeg('node 22', 'npx', ['-y', 'node@22'], ['-y', 'node@22', '--version']);
await runLeg('bun', 'bun', [], ['--version']);

await step('esbuild tree-shaking bundle', 'node', ['bundle.mjs'], BOOT_DIR);
const bundled = await run('node', ['bundled.mjs', String(freePort())], BOOT_DIR);
legs.push(classifyLeg('esbuild / node 24', bundled.code, bundled.output));

const outcome = decideOutcome(legs, requireAll);
for (const line of outcome.lines) console.log(line);
Deno.exit(outcome.code);
