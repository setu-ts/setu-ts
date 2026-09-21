/**
 * The one devtool planner — every entry point that emits devtool wiring calls
 * these functions, so the files `setu new --devtool`, `setu generate app
 * --devtool` and `setu devtool enable` produce cannot drift. This is the
 * repo's one-capability-one-implementation rule applied to a scaffolding verb:
 * `new` and `generate app` only CREATE, so a project that already exists needs
 * the standalone command, and all three share what gets emitted.
 *
 * Everything here is internal to `packages/cli/src`: the plan's exported
 * surface is `WorkspaceMember.devtoolPort` alone, read by the allocator, the
 * dev runner, `ports --reallocate` and the launcher.
 *
 * @module
 */

import { CONFIG_EXPORT, type TargetRuntime } from '../constants.ts';
import type { EntryPort, ResolvedHost } from '../templates/project-files.ts';
import { DEVTOOL_ENTRY_MODULE, devtoolTasks } from '../templates/project-files.ts';
import { workspaceDevRunner } from '../workspace/dev-runner.ts';
import { DEVTOOL_ENV_NAMES, workspaceProfile } from '../workspace/runtime-profile.ts';
import { renderDevEntry } from './dev-entry.ts';

/** Re-exported so command code reads one module for the devtool surface. */
export { DEVTOOL_ENTRY_MODULE };

/**
 * The devtool port a standalone project gets when none is supplied.
 *
 * A workspace allocates; a standalone project has no allocation space, so it
 * takes the documented example port. An explicit `--devtool-port` overrides it,
 * range-checked like every other port; a collision fails at bind time with the
 * listener's own named refusal, exactly as a colliding application port does.
 */
export const DEFAULT_DEVTOOL_PORT = 4919;

/**
 * The workspace runner a devtool-enabled member needs, and where it goes.
 *
 * Only the Deno runner can host a devtool member — the connector refuses every
 * non-Deno `listen`, and the opt-in is refused on the other two profiles before
 * anything is written.
 *
 * @returns The runner's workspace-relative path and its current rendering
 */
export function devtoolDevRunner(): { readonly path: string; readonly contents: string } {
  return workspaceDevRunner(workspaceProfile('deno'));
}

/**
 * Names why a workspace's existing `scripts/dev.ts` cannot host the devtool.
 *
 * This is the three-outcome merge contract applied to the runner SCRIPT rather
 * than only to the root `dev` task string that invokes it. The root task is
 * widened in place from its pre-devtool value, so this command already knows it
 * may be operating on a workspace created before the devtool existed; the
 * script that task runs was left alone, and `devtool enable` therefore reported
 * success on such a workspace while `deno task dev` went on spawning `main.ts`
 * for every member. The connector never bound — and had it bound, the
 * pre-devtool runner passes no per-child `env`, so every sibling would have
 * inherited the credential pair M98b forbids them to see.
 *
 * Detection is the CONTRACT, not a byte comparison against a stored copy of the
 * old rendering: a runner that reads {@linkcode DEVTOOL_ENV_NAMES} honors the
 * handoff whether this CLI wrote it or the developer did, and one that does not
 * cannot, however it got there. The file is the developer's once written —
 * nothing regenerates it — so a runner this cannot classify is refused with its
 * remedy rather than overwritten.
 *
 * @param existing - The current `scripts/dev.ts`, or `undefined` when absent
 * @param path - The runner's path, for the refusal
 * @returns The refusal message, or `undefined` when the runner already honors
 * the contract, or is absent and will be created
 */
export function devtoolRunnerRefusal(
  existing: string | undefined,
  path: string,
): string | undefined {
  // Absent: the root `dev` task points at nothing, so this workspace cannot
  // run at all today. Writing the current rendering repairs it rather than
  // discarding anything.
  if (existing === undefined) return undefined;
  if (DEVTOOL_ENV_NAMES.every((name) => existing.includes(name))) return undefined;
  return (
    `${path} predates the devtool: it starts every member with that member's \`start\`` +
    ` task and passes no per-child environment, so the development entry would never run` +
    ` and the launcher would meet a closed port. It also hands every member the runner's` +
    ` whole environment, which is how a sibling would come to hold this session's` +
    ` credentials.\n` +
    `The runner is yours once written, so this command will not overwrite it. Delete` +
    ` ${path} and run this again — it is rewritten with the devtool-aware runner — or` +
    ` port the change yourself: read ${DEVTOOL_ENV_NAMES.join(', ')}, spawn the named` +
    ` member's \`dev\` task instead of \`start\`, and give every child an explicit \`env\`` +
    ` that blanks all three for every other member.`
  );
}

/**
 * The fragment that marks a config factory as carrying the devtool parameter.
 *
 * Detection for `setu devtool enable` is textual and CONSERVATIVE: it refuses
 * only on the shapes the CLI itself has emitted, which are known strings, so a
 * hand-edited factory the check cannot classify proceeds rather than being
 * refused wrongly. This fragment is what the emitted shapes share, so its
 * presence means the factory already takes the composition.
 */
export const DEVTOOL_PARAMETER_MARK = 'devtool?: { plugins?: readonly IPlugin[];';

/**
 * The factory signatures the CLI emitted BEFORE the devtool parameter existed,
 * byte-for-byte as this package wrote them.
 *
 * Against a zero-parameter factory `deno run` accepts the dev entry's two
 * arguments in silence — both are discarded, and the application carries no
 * connector — while `deno check` refuses the same call with TS2554. That
 * silence is why a project scaffolded before this letter is the commonest
 * input to `devtool enable`, and why the refusal names the file and the exact
 * signature to write: nothing else in the project will report the mismatch.
 */
const LEGACY_FACTORY_SHAPES: readonly string[] = [
  // The socket targets (Deno, Node, Bun), before the parameter existed.
  `export function ${CONFIG_EXPORT}(): IApplication {`,
  // The starter-composed factory, before the parameter existed.
  `export async function ${CONFIG_EXPORT}(\n  env?: Readonly<Record<string, unknown>>,\n): Promise<IApplication> {`,
];

/** The exact factory signature the refusal tells a developer to write. */
const EXPECTED_SIGNATURE = `export function createApp(\n` +
  `  _env?: Readonly<Record<string, unknown>>,\n` +
  `  devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions },\n` +
  `): IApplication {`;

/**
 * Returns why a config module cannot host the devtool, or `undefined` when it
 * can — or when the check cannot classify it, which proceeds: the refusal is
 * deliberately limited to the known pre-letter shapes, and the emitted `check`
 * task is the backstop that turns a genuinely mismatched hand-written factory
 * into a TS2554 at the project's own gate.
 *
 * @param source - The `setu.config.ts` contents
 * @returns The refusal message, or `undefined` to proceed
 */
export function legacyFactoryRefusal(source: string): string | undefined {
  if (source.includes(DEVTOOL_PARAMETER_MARK)) return undefined;
  const legacy = LEGACY_FACTORY_SHAPES.find((shape) => source.includes(shape));
  if (legacy === undefined) return undefined;
  return (
    `This project's setu.config.ts declares the factory this CLI emitted before the` +
    ` devtool existed, so the development entry's composition would be discarded in` +
    ` silence: \`deno run\` drops both arguments, the application carries no` +
    ` connector, and nothing else in the project reports why. Edit setu.config.ts so` +
    ` the factory takes the devtool composition as its SECOND parameter:\n\n` +
    `${EXPECTED_SIGNATURE}\n\n` +
    `Then run this command again. The development entry this command writes passes` +
    ` the composition there; the project's new \`check\` task will type-check it.`
  );
}

/** The starter-composed factory's signature opening, as this package renders it. */
export const STARTER_FACTORY_MARK = `export async function ${CONFIG_EXPORT}(`;

/**
 * Names why a config module composed through a starter factory cannot host the
 * devtool, used by `setu devtool enable`, which meets a project's WRITTEN
 * config rather than a resolved host.
 *
 * The starter-composed rendering is the only async factory shape this CLI
 * emits, so the async opening identifies it. Unlike
 * {@linkcode legacyFactoryRefusal}, this check has no cannot-classify
 * fallback — a hand-written async `createApp` is refused too, because the
 * async shape is the only signal available and refusing is the safe side: a
 * connector registered onto an application built elsewhere would refuse to
 * activate at start with nothing saying why. The message therefore names the
 * limit rather than asserting the project composes through a starter.
 *
 * @param source - The `setu.config.ts` contents
 * @returns The refusal message, or `undefined` for a plugin-list composition
 */
export function starterConfigRefusal(source: string): string | undefined {
  if (!source.includes(STARTER_FACTORY_MARK)) return undefined;
  return (
    `This project's createApp is async, which is the shape this CLI emits for a` +
    ` starter-composed factory — and a starter owns its construction, while kernel` +
    ` diagnostics must be enabled at construction, the one place this CLI cannot reach.` +
    ` The devtool therefore cannot be enabled here.\nIf you wrote this factory yourself` +
    ` rather than scaffolding a starter template, nothing is wrong with it: this check` +
    ` cannot tell the two apart, so wire the diagnostics plugin into your own` +
    ` development entry and pass the kernel diagnostics option where you construct the` +
    ` application.`
  );
}

/**
 * Applies the devtool composition to a resolved host: the development entry
 * file, the `dev` and `check` tasks, and the diagnostics-plugin dependency the
 * entry imports.
 *
 * The last part is what keeps a devtool-enabled project self-describing: the
 * entry imports `DiagnosticsPlugin`, and the manifest writer pins every
 * package the project's source references from this one list, so the import
 * map can never omit what `main.dev.ts` resolves.
 *
 * @param host - The resolved template host, after its runtime and env overlays
 * @param devtoolPort - The loopback port the connector binds
 * @param port - The application port import, for a workspace member
 * @returns The host with the devtool composition applied
 */
export function withDevtool(
  host: ResolvedHost,
  devtoolPort: number,
  port?: EntryPort,
): ResolvedHost {
  return {
    ...host,
    extraTasks: { ...host.extraTasks, ...devtoolTasks(host.manifest) },
    packageImports: [...host.packageImports, { pkg: 'diagnostics-plugin' }],
    files: [
      ...host.files,
      {
        path: DEVTOOL_ENTRY_MODULE,
        // Omitted rather than passed as `undefined`: exactOptionalPropertyTypes.
        contents: renderDevEntry({
          devtoolPort,
          ...(port === undefined ? {} : { port }),
        }),
      },
    ],
  };
}

/**
 * Names why the devtool opt-in cannot apply to a runtime, when it cannot.
 *
 * The listener rejects every non-Deno `listen` before any bind
 * (`local-diagnostics-listener.ts`), so a devtool-enabled non-Deno project
 * would fail at startup rather than degrade — refused here, at every entry
 * point, before anything is written.
 *
 * @param runtime - The target runtime
 * @returns The refusal message, or `undefined` for Deno
 */
export function devtoolRuntimeRefusal(runtime: TargetRuntime): string | undefined {
  if (runtime === 'deno') return undefined;
  return (
    `The devtool requires the Deno runtime: the diagnostics listener refuses every` +
    ` non-Deno \`listen\` before it binds, so a ${runtime} project could never start` +
    ` the connector it was scaffolded with. Scaffold without --devtool, or create` +
    ` the project with --runtime deno.`
  );
}

/**
 * Names why the devtool opt-in cannot apply to a starter-composed template.
 *
 * A starter factory owns its construction, and kernel diagnostics reach the
 * application CONSTRUCTOR only — `createFullStackAppFromConfig` accepts no
 * diagnostics option — so a connector registered onto the finished application
 * would refuse to activate with "kernel diagnostics not enabled". Refused at
 * scaffold and enable time by name rather than discovered at run.
 *
 * @param host - The resolved template host
 * @returns The refusal message, or `undefined` for a plugin-list composition
 */
export function devtoolStarterRefusal(host: ResolvedHost): string | undefined {
  if (host.appFactory === undefined) return undefined;
  return (
    `The "${host.appFactory.symbol}" starter composes its whole plugin set through its` +
    ` own factory, and kernel diagnostics must be enabled at construction — the one` +
    ` place this CLI cannot reach. The devtool therefore cannot be enabled on this` +
    ` template: scaffold a plugin-list template (rest, microservice, or none) with` +
    ` --devtool instead.`
  );
}

/**
 * Derives a project's `dev` task from its own `start` task by swapping the
 * entry module.
 *
 * Used by `setu devtool enable`, which meets a project this CLI may have
 * scaffolded before this letter: reading the START task it already runs — not
 * recomputing permissions the enable command cannot know — is what guarantees
 * the two tasks differ only in the entry module, for any project whose start
 * names `main.ts`. A start task this cannot read (a different entry, or no
 * task at all) is refused by name with its current value.
 *
 * @param startTask - The project's current `start` task body
 * @returns The `dev` task body, or `undefined` when the start task names no
 * swappable `main.ts` entry
 */
export function deriveDevTask(startTask: string): string | undefined {
  const suffix = ' main.ts';
  if (!startTask.endsWith(suffix)) return undefined;
  return `${startTask.slice(0, -suffix.length)} ${DEVTOOL_ENTRY_MODULE}`;
}

/**
 * The `check` task body `setu devtool enable` merges into an existing
 * project's `deno.json`, computed from the same renderer the create-time path
 * uses so the two cannot disagree. The check task depends on no template
 * option — it names the three modules every devtool-enabled project carries.
 */
export function devtoolCheckTask(): string {
  return devtoolTasks().check;
}
