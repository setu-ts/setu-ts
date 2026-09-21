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
 * emits, so the async opening identifies it exactly; a hand-written async
 * factory that this check cannot classify proceeds, like the legacy-factory
 * check it runs beside.
 *
 * @param source - The `setu.config.ts` contents
 * @returns The refusal message, or `undefined` for a plugin-list composition
 */
export function starterConfigRefusal(source: string): string | undefined {
  if (!source.includes(STARTER_FACTORY_MARK)) return undefined;
  return (
    `This project composes through a starter factory, which owns its construction — and` +
    ` kernel diagnostics must be enabled at construction, the one place this CLI cannot` +
    ` reach. The devtool therefore cannot be enabled here. The refusal is limited to the` +
    ` factory shape this CLI emits; if you composed the application yourself, wire the` +
    ` diagnostics plugin in your own development entry.`
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
