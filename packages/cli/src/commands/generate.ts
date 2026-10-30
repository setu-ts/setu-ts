/**
 * The `setu generate` command — plugin-aware code generation.
 *
 * @module
 */

import { formatForTarget } from '../utils/prettier-format.ts';
import type { IFileSystem } from '@setu-ts/common';
import { diagnoseProject, type ProjectDiagnosis } from '../diagnostics/diagnose.ts';
import { refuseDuplicateNames, renderGenerateFindings } from '../diagnostics/render.ts';
import type { ParsedArgs } from '../args.ts';
import { stringFlag } from '../args.ts';
import {
  APP_VERB,
  EXIT_ERROR,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_USAGE,
  isTargetRuntime,
  LIBRARY_VERB,
  PROGRAM_NAME,
  TARGET_RUNTIMES,
  type TargetRuntime,
} from '../constants.ts';
import { runAppCommand } from './app.ts';
import type { PortProbe } from '../workspace/port-probe.ts';
import { runLibraryCommand } from './library.ts';
import {
  deriveNames,
  escapeName,
  IDENTIFIER_NAME_RULE,
  isIdentifierSafe,
  overlongComponent,
} from '../utils/names.ts';
import { detectPlugins } from '../utils/plugin-detector.ts';
import { detectTargetRuntime, RuntimeMarkerUnreadableError } from '../utils/runtime-detector.ts';
import { readJsonManifest } from '../utils/manifest-reader.ts';
import { detectProject } from '../utils/project-detector.ts';
import {
  findExisting,
  reportDryRunPlan,
  type GeneratedFile,
  joinPath,
  resolveDir,
  withFileTransaction,
  writeFiles,
} from '../utils/file-writer.ts';
import {
  CUSTOM_SCHEMATIC,
  getSchematic,
  listSchematics,
  type DerivedNames,
  type Schematic,
  type SchematicOptions,
} from '../schematics/registry.ts';
import { readBarrel } from '../diagnostics/barrel-drift.ts';
import { planModuleSwitch, type IModuleSwitch } from '../utils/module-switch.ts';
import { pruneAdoptedDirectories } from '../workspace/adopt.ts';
import {
  withModuleDeclarationEntry,
  type ModuleDeclarationProperty,
} from '../utils/module-declaration.ts';
import {
  CUSTOM_SCHEMATIC_DIR,
  isCustomSchematicName,
  loadCustomSchematic,
  type ModuleLoader,
} from '../schematics/custom.ts';
import { serviceSeamToken } from '../seams/services.ts';
import type { AdoptedArtifact } from '../utils/artifact-scanner.ts';
import { findNameConflict } from '../utils/name-conflicts.ts';
import { repositoryFileUrl } from '../utils/repository-links.ts';
import { readMigrationNames } from '../utils/migration-scanner.ts';
import { interruptionMessage } from '../utils/interruption.ts';

import { createCommandRunner, type CommandRunner } from '../utils/run-command.ts';
import { kernelShadows, readPagePaths } from '../utils/react-router-routes.ts';
import { cliInvocation } from '../templates/project-files.ts';

/**
 * Everything `runGenerateCommand` reaches the outside world through.
 */
export interface GenerateDependencies {
  /** The filesystem to detect plugins on and write generated files through. */
  readonly fs: IFileSystem;
  /** Runs the installed React Router route-tree command. */
  readonly runCommand?: CommandRunner;
  /** The project directory to operate on (absolute). */
  readonly cwd: string;
  /** Wall-clock milliseconds, for timestamped output. */
  readonly now: () => number;
  /** Writes a line of normal output. */
  readonly log: (message: string) => void;
  /** Writes a line of error output. */
  readonly error: (message: string) => void;
  /** Loads a custom schematic module; defaults to a real dynamic `import()`. */
  readonly load?: ModuleLoader;
  /** Checks whether a workspace port can bind before an app is assigned one. */
  readonly portAvailable?: PortProbe;
  /** Cooperative interruption signal checked at write boundaries. */
  readonly interrupt?: AbortSignal;
}

/**
 * Selects the schematic metadata available to this installed plugin set.
 *
 * @param installed - The `@setu-ts` packages detected in the project
 * @returns The available schematics, in registry order
 */
export function availableSchematics(
  installed: ReadonlySet<string>,
): ReturnType<typeof listSchematics> {
  return listSchematics().filter(({ requiresPlugin: fixed, requiresPluginWhen }) => {
    const required = fixed ?? requiresPluginWhen?.(installed);
    return required === undefined || installed.has(required);
  });
}

function printSchematics(installed: ReadonlySet<string>, log: (message: string) => void): void {
  log(`Usage: ${PROGRAM_NAME} generate <schematic> <name> [options]`);
  log('');
  log('Schematics:');
  const available = new Set(availableSchematics(installed).map((entry) => entry.name));
  for (const { name, requiresPlugin: fixed, requiresPluginWhen } of listSchematics()) {
    const requiresPlugin = fixed ?? requiresPluginWhen?.(installed);
    if (available.has(name)) {
      log(`  ${name}`);
    } else {
      log(
        `  ${name}  (unavailable — run \`${PROGRAM_NAME} add ` +
          `${requiresPlugin!.replace(/-plugin$/, '')}\`)`,
      );
    }
  }
  log(`  ${CUSTOM_SCHEMATIC} <schematic-name>  (from .setu-ts/schematics/)`);
  log(`  ${APP_VERB} <name>  (adds a service to a workspace)`);
  log(`  ${LIBRARY_VERB} <name>  (adds shared code to a workspace)`);
  log('');
  log('Options:');
  log('  --dry-run          Print what would be created, write nothing');
  log('  --dir <path>       Generate into this directory instead of the CWD');
  log(
    `  --runtime <target>  ${TARGET_RUNTIMES.join(' | ')} (detected from the project by default)`,
  );
  log(
    '  --module <name>     Place a controller, route, service, sse or schema inside a feature module;',
  );
  log('                      required for the first four once the project has modules');
  log('  --adopt-controllers The first module only: move src/controllers/ and src/services/');
  log('                      into it, rewriting imports and keeping their URLs');
}

/**
 * Runs `setu generate`.
 *
 * Resolves the schematic (built-in or custom), refuses a gated schematic whose
 * plugin is not installed, checks every planned path for an existing file
 * BEFORE the first write, and writes nothing at all under `--dry-run`.
 *
 * @param args - Arguments after the `generate` verb, already parsed
 * @param deps - Filesystem, clock, and output sinks
 * @returns `0` on success — including the bare `generate` listing, which is
 *   informational rather than an error — `1` on a runtime error, `2` on a usage
 *   error
 */
export async function runGenerateCommand(
  args: ParsedArgs,
  deps: GenerateDependencies,
): Promise<number> {
  const dir = resolveDir(deps.cwd, stringFlag(args.flags, 'dir'));

  // Dispatched FIRST, before `--help` and before the plugin scan: `app` adds a
  // workspace member rather than generating a file into a project, so it has its
  // own usage text, and the detected plugin set of a workspace ROOT (which
  // installs nothing) would say nothing about the member being created.
  if (args.positionals[0] === APP_VERB) {
    return await runAppCommand(args, {
      fs: deps.fs,
      dir,
      log: deps.log,
      error: deps.error,
      ...(deps.portAvailable === undefined ? {} : { portAvailable: deps.portAvailable }),
      ...(deps.interrupt === undefined ? {} : { interrupt: deps.interrupt }),
    });
  }

  // Dispatched beside `app`, and for the same reasons: it is not a schematic, and
  // the detected plugin set of a workspace ROOT — which installs nothing — would
  // say nothing about a library that depends on no plugin at all.
  if (args.positionals[0] === LIBRARY_VERB) {
    return await runLibraryCommand(args, {
      fs: deps.fs,
      dir,
      log: deps.log,
      error: deps.error,
      ...(deps.interrupt === undefined ? {} : { interrupt: deps.interrupt }),
    });
  }

  // `--help` is never an error, with or without a schematic named.
  if (args.flags['help'] === true || args.flags['h'] === true) {
    const installed = await detectPlugins(deps.fs, dir);
    printSchematics(installed, deps.log);
    return EXIT_OK;
  }

  // Validated ABOVE the bare-arm listing so the informational listing cannot
  // silently swallow an invalid `--runtime` (exiting 0 over a typo read as
  // success). Rejected rather than defaulted: a custom schematic branches on
  // `options.runtime`, so silently swallowing a typo would change the
  // generated output with no diagnostic. `new` rejects it the same way.
  const runtimeValue = args.flags['runtime'];
  if (runtimeValue !== undefined && typeof runtimeValue !== 'string') {
    deps.error(
      `Option --runtime requires a value. Expected one of: ${TARGET_RUNTIMES.join(', ')}.`,
    );
    return EXIT_USAGE;
  }
  if (typeof runtimeValue === 'string' && !isTargetRuntime(runtimeValue)) {
    deps.error(
      `Unknown runtime "${escapeName(runtimeValue)}". Expected one of: ${TARGET_RUNTIMES.join(
        ', ',
      )}.`,
    );
    return EXIT_USAGE;
  }
  const runtimeFlag = runtimeValue;
  const moduleFlag = args.flags['module'];
  if (
    moduleFlag !== undefined &&
    (typeof moduleFlag !== 'string' ||
      moduleFlag.includes('/') ||
      moduleFlag.includes('\\') ||
      !isIdentifierSafe(deriveNames(moduleFlag)))
  ) {
    deps.error('Option --module requires a valid module name.');
    return EXIT_USAGE;
  }

  const schematicName = args.positionals[0];
  const adoptControllers = args.flags['adopt-controllers'] === true;
  if (adoptControllers && schematicName !== 'module') {
    deps.error(
      '--adopt-controllers applies only to `g module`, which moves the flat controllers and services into the new module.',
    );
    return EXIT_USAGE;
  }
  if (schematicName === undefined) {
    // Informational, exactly like the `--help` branch above: the listing is
    // ordinary output (identical text, same log sink), so an error exit
    // contradicted the guidance it carried. Everything that genuinely fails —
    // an invalid `--runtime` (refused above), a missing name, an unknown
    // schematic, over-arity — still exits 2.
    printSchematics(await detectPlugins(deps.fs, dir), deps.log);
    return EXIT_OK;
  }

  let schematic: Schematic | undefined;
  let name: string | undefined;
  let customName: string | undefined;
  let requiredPlugin: string | undefined;

  if (schematicName === CUSTOM_SCHEMATIC) {
    customName = args.positionals[1];
    name = args.positionals[2];
    if (customName === undefined || name === undefined) {
      deps.error(`Usage: ${PROGRAM_NAME} generate custom <schematic-name> <name>`);
      return EXIT_USAGE;
    }
    if (!isCustomSchematicName(customName)) {
      deps.error(
        `Invalid custom schematic name "${escapeName(
          customName,
        )}": use letters, digits, "-" and "_" — it names a file in ${CUSTOM_SCHEMATIC_DIR}/`,
      );
      return EXIT_USAGE;
    }
  } else {
    const metadata = getSchematic(schematicName);
    if (metadata === undefined) {
      deps.error(`Unknown schematic: ${escapeName(schematicName)}`);
      printSchematics(await detectPlugins(deps.fs, dir), deps.log);
      return EXIT_USAGE;
    }

    name = args.positionals[1];
    if (name === undefined) {
      deps.error(`Usage: ${PROGRAM_NAME} generate ${escapeName(schematicName)} <name>`);
      return EXIT_USAGE;
    }

    schematic = metadata.factory;
    requiredPlugin = metadata.requiresPlugin;
  }

  const names = deriveNames(name);
  if (!isIdentifierSafe(names)) {
    // Schematics interpolate these forms into declarations, so a name that
    // cannot begin an identifier would emit source that does not parse.
    // Quoting the name back as typed, so through `escapeName`: a control
    // character here would forge a standalone line in the rendered message.
    deps.error(`Invalid name "${escapeName(name)}": ${IDENTIFIER_NAME_RULE}`);
    return EXIT_USAGE;
  }

  const project = await detectProject(deps.fs, dir);
  if (project.kind === 'none') {
    deps.error(
      `${escapeName(
        dir,
      )} holds no deno.json, deno.jsonc or package.json — run this inside a project, or pass --dir.`,
    );
    return EXIT_ERROR;
  }
  if (project.kind === 'workspace-root') {
    deps.error(
      `${escapeName(dir)} is a workspace root (${escapeName(
        project.marker,
      )}); generate inside a member instead.`,
    );
    deps.error(`  Pass --dir apps/<member>.`);
    return EXIT_USAGE;
  }
  if (project.kind === 'unreadable') {
    deps.error(`Cannot read ${escapeName(project.path)}: ${escapeName(project.reason)}`);
    return EXIT_ERROR;
  }

  const installed = await detectPlugins(deps.fs, dir);
  requiredPlugin ??= getSchematic(schematicName)?.requiresPluginWhen?.(installed);

  // Detected from the project rather than defaulted, because the project already
  // knows: `setu new svc --runtime bun` records the choice once and nobody
  // repeats it on every `generate`. An explicit flag still wins, so a custom
  // schematic can be driven for another target deliberately.
  let runtime: TargetRuntime;
  try {
    runtime = runtimeFlag ?? (await detectTargetRuntime(deps.fs, dir));
  } catch (cause) {
    if (!(cause instanceof RuntimeMarkerUnreadableError)) throw cause;
    deps.error(cause.message);
    return EXIT_ERROR;
  }
  const module = typeof moduleFlag === 'string' ? deriveNames(moduleFlag).kebab : undefined;
  if (
    module !== undefined &&
    !['service', 'route', 'controller', 'sse', 'schema'].includes(schematicName)
  ) {
    const artifact = getSchematic(schematicName)
      ?.factory(names, { runtime, plugins: installed, now: deps.now })
      .find((file) => file.managed !== true)?.path;
    const directory = artifact === undefined ? 'src' : artifact.slice(0, artifact.lastIndexOf('/'));
    deps.error(
      `--module places a feature file; ${schematicName} is app-wide and lives in ${directory}.`,
    );
    return EXIT_USAGE;
  }

  // Read unconditionally, like `detectPlugins` above: the `module` schematic
  // needs it to render its aggregate barrel, and branching on the schematic name
  // here would put a second dispatch beside the registry.
  const diagnosis = await diagnoseProject(
    deps.fs,
    dir,
    installed,
    module === undefined ? undefined : { module },
  );
  if (refuseDuplicateNames(diagnosis, deps.error)) return EXIT_ERROR;

  if (schematicName === 'job' && diagnosis.starter?.arms.has('queue-plugin') === true) {
    requiredPlugin = 'queue-plugin';
  }

  // Resolve project-owned code and plugin gates only after the target has been
  // established as a readable project. Otherwise a missing plugin or custom
  // module can mask the more fundamental wrong-directory refusal.
  if (customName !== undefined) {
    try {
      schematic = await loadCustomSchematic(dir, customName, deps.load);
    } catch (cause) {
      deps.error(escapeName(cause instanceof Error ? cause.message : String(cause)));
      return EXIT_ERROR;
    }
  } else if (requiredPlugin !== undefined && !installed.has(requiredPlugin)) {
    deps.error(
      `The "${schematicName}" schematic requires @setu-ts/${requiredPlugin}, ` +
        `which is not installed in ${escapeName(dir)}.`,
    );
    if (diagnosis.starter?.arms.has(requiredPlugin) === true) {
      deps.error(
        `${diagnosis.starter.symbol} already runs ${requiredPlugin}; add installs its package and wires the generated handlers into setu.config.ts.`,
      );
    }
    deps.error(
      `Run \`${cliInvocation(runtime)} add ${requiredPlugin.replace(
        /-plugin$/,
        '',
      )}\`, then this command again.`,
    );
    return EXIT_ERROR;
  }

  if (schematic === undefined) {
    deps.error(`Could not resolve schematic: ${escapeName(schematicName)}`);
    return EXIT_ERROR;
  }
  const { mode, modules, legacyModules } = diagnosis;
  const scan = diagnosis;
  // One home for routes and services (§4.8): a flat project has none in
  // modules, and a modular one has none outside them.
  if (PLACED_SCHEMATICS.includes(schematicName)) {
    if (module !== undefined && modules.length === 0) {
      deps.error(
        `This project has no modules; run \`${cliInvocation(runtime)} g module ${escapeName(module)}\` first, or drop --module.`,
      );
      return EXIT_ERROR;
    }
    if (module === undefined && diagnosis.layout !== 'flat') {
      deps.error(
        `This project uses modules; pass --module <name> (existing: ${modules.map(escapeName).join(', ')}).`,
      );
      return EXIT_USAGE;
    }
  }
  if (module !== undefined) {
    if (!modules.includes(module)) {
      deps.error(
        `Unknown module "${escapeName(module)}". Admitted modules: ${
          modules.map(escapeName).join(', ') || '(none)'
        }.`,
      );
      return EXIT_ERROR;
    }
  }
  const migrations = await readMigrationNames(deps.fs, dir);
  renderGenerateFindings(diagnosis, deps.error);

  // Refused BEFORE the schematic runs, and before `--dry-run` prints: a plan whose
  // output cannot work is not a plan worth printing. Both collisions this catches were
  // observed as real failures against a booted application — see `name-conflicts.ts`.
  const conflict = findNameConflict(
    schematicName,
    names.kebab,
    installed,
    scan.artifacts,
    module === undefined ? modules : [],
    module,
  );
  if (conflict !== undefined) {
    deps.error(
      `Cannot generate ${escapeName(schematicName)} "${names.kebab}": ${escapeName(
        conflict.resource,
      )} is already ` + `claimed by ${escapeName(conflict.claimedBy)}.`,
    );
    deps.error(`If both existed, ${escapeName(conflict.consequence)}.`);
    deps.error(`Choose a different name, or ${escapeName(conflict.remedy)}.`);
    return EXIT_ERROR;
  }

  if (
    installed.has('react-router-plugin') &&
    ['route', 'controller', 'module'].includes(schematicName)
  ) {
    const base = `/${module === undefined ? '' : `${module}/`}${names.kebab}`;
    const pages = await readPagePaths(dir, deps.runCommand ?? createCommandRunner());
    if (!pages.ok) {
      deps.error(
        `Notice: cannot check React Router pages (${escapeName(pages.reason)}); check ${base} and ${base}/:id against app/routes.ts and app/routes/ by hand.`,
      );
    } else {
      const page = pages.paths.find((path) => kernelShadows(base, path));
      if (page !== undefined) {
        deps.error(
          `Cannot generate ${schematicName} "${names.kebab}": its kernel routes ${base} and ${base}/:id would take precedence over the React Router page ${escapeName(page)} (${escapeName(pages.files.get(page)!)}).`,
        );
        deps.error(
          schematicName === 'module'
            ? `Choose another module name: a module's routes are mounted at /<module name>.`
            : `Choose another name, or place the ${schematicName} in a module: setu g module api (with --adopt-controllers if the project has controllers), then setu g ${schematicName} ${names.kebab} --module api (which yields /api/${names.kebab}).`,
        );
        return EXIT_ERROR;
      }
    }
  }

  const options: SchematicOptions = {
    runtime,
    plugins: installed,
    now: deps.now,
    modules,
    legacyModules,
    migrations,
    artifacts: scan.artifacts,
    ...(module === undefined ? {} : { targetModule: module, moduleArtifacts: scan.artifacts }),
  };

  let generated: readonly GeneratedFile[];
  try {
    generated = schematic(names, options);
  } catch (cause) {
    deps.error(
      `Schematic "${escapeName(schematicName)}" failed: ${escapeName(
        cause instanceof Error ? cause.message : String(cause),
      )}`,
    );
    return EXIT_ERROR;
  }

  // A class controller or service generated into a class-based module joins the
  // module's own `@Module` declaration, as the NestJS CLI does. A declaration the
  // editor cannot read exactly is left alone and the line to add is printed.
  let declarationAdvice: string | undefined;
  const declaration =
    module !== undefined && mode === 'class-based'
      ? moduleDeclarationTarget(schematicName, names)
      : undefined;
  if (module !== undefined && declaration !== undefined) {
    const path = `src/modules/${module}/${module}.module.ts`;
    const read = await readBarrel(deps.fs, joinPath(dir, path));
    const edit =
      read.kind === 'source'
        ? withModuleDeclarationEntry(
            read.source,
            declaration.property,
            declaration.symbol,
            declaration.specifier,
          )
        : ({ kind: 'unreadable' } as const);
    if (edit.kind === 'edited')
      generated = [...generated, { path, contents: edit.source, managed: true }];
    else if (edit.kind === 'unreadable')
      declarationAdvice = `Add ${declaration.symbol} to @Module({ ${declaration.property} }) in ${path}; the CLI edits only a plain array literal there.`;
  }

  // The first module switches the project from flat to modular (§4.7): it takes
  // the flat controllers and services with it, or refuses.
  let moduleSwitch: IModuleSwitch | undefined;
  // The switch's config and importer edits are the developer's files with only
  // their import lines changed, so they are written verbatim, never reformatted.
  const verbatim = new Set<string>();
  if (schematicName === 'module' && modules.length === 0) {
    let planned: Awaited<ReturnType<typeof planModuleSwitch>>;
    try {
      planned = await planModuleSwitch({
        fs: deps.fs,
        dir,
        module: names.kebab,
        mode,
        adopt: adoptControllers,
        artifacts: scan.artifacts,
        generated,
        cli: cliInvocation(runtime),
      });
    } catch (cause) {
      // A linked directory under src/ or an unreadable file: nothing was written.
      deps.error(
        `Cannot plan the switch to modules: ${escapeName(cause instanceof Error ? cause.message : String(cause))}. Nothing was changed.`,
      );
      return EXIT_ERROR;
    }
    if (planned.kind === 'refused') {
      for (const line of planned.lines) deps.error(line);
      return EXIT_ERROR;
    }
    moduleSwitch = planned.plan;
    const replaced = new Map(moduleSwitch.writes.map((file) => [file.path, file]));
    for (const file of moduleSwitch.writes)
      if (!generated.some((own) => own.path === file.path)) verbatim.add(joinPath(dir, file.path));
    generated = [
      ...generated.map((file) => replaced.get(file.path) ?? file),
      ...moduleSwitch.writes.filter((file) => !generated.some((own) => own.path === file.path)),
    ];
  } else if (adoptControllers) {
    deps.error(
      '--adopt-controllers applies only to the first module, which switches a flat project to modules.',
    );
    return EXIT_USAGE;
  }

  // Root every path at the target directory before touching the filesystem, so
  // the overwrite check and the write agree on exactly the same paths.
  // Spread the file rather than rebuilding it from two known fields: dropping a
  // member here silently discards whatever the schematic declared about it, and
  // losing `managed` makes the aggregate module barrel refuse on every run after
  // the first.
  const files: readonly GeneratedFile[] = generated.map((file) => ({
    ...file,
    path: joinPath(dir, file.path),
  }));

  if (files.length === 0) {
    deps.error(`Schematic "${escapeName(schematicName)}" produced no files.`);
    return EXIT_ERROR;
  }

  // The name guard bounds the kebab, but a schematic APPENDS to it
  // (`<kebab>.controller.ts`), so a name within the bound can still plan a file
  // name the filesystem refuses — an uncaught `File name too long` from the
  // overwrite probe below. Checked against the schematic's own relative paths,
  // so a long `--dir` is not mistaken for the name, and before `--dry-run`, so
  // the dry run never prints a plan the real run could not carry out.
  const overlong = overlongComponent(generated.map((file) => file.path));
  if (overlong !== undefined) {
    deps.error(
      `Cannot generate "${escapeName(name)}": the file name ${overlong} is over 255 bytes, ` +
        `the limit for one path component. Use a shorter name.`,
    );
    return EXIT_USAGE;
  }

  // X4-4/F2: adoption happens only when a barrel this command WRITES claims a file
  // the CLI did not write. A claim into any other barrel is not an adoption — that
  // barrel does not change — so the scan's candidates are filtered by the plan. A
  // custom schematic is excluded outright: a matching path says nothing about what
  // it wrote there, so the CLI cannot vouch that its barrel registers the file.
  const planned = new Set(generated.map((file) => file.path));
  const adoptions =
    customName === undefined ? scan.adopted.filter((claim) => planned.has(claim.barrel)) : [];

  const dryRun = args.flags['dry-run'] === true;
  if (!dryRun) {
    const existing = await findExisting(deps.fs, [
      ...files,
      ...(moduleSwitch?.moves ?? []).map((move) => ({
        path: joinPath(dir, move.to),
        contents: '',
      })),
    ]);
    if (existing.length > 0) {
      deps.error('Refusing to overwrite existing files:');
      for (const path of existing) deps.error(`  ${escapeName(path)}`);
      return EXIT_ERROR;
    }
  }

  try {
    const formatted = [
      ...(await formatForTarget(
        files.filter((file) => !verbatim.has(file.path)),
        runtime,
        dir,
        deps.error,
      )),
      ...files.filter((file) => verbatim.has(file.path)),
    ];
    if (dryRun) {
      // A move onto an existing file is refused by the real run, so the dry run says so.
      const blocked = new Set(
        await findExisting(
          deps.fs,
          (moduleSwitch?.moves ?? []).map((move) => ({
            path: joinPath(dir, move.to),
            contents: '',
          })),
        ),
      );
      for (const move of moduleSwitch?.moves ?? [])
        if (!blocked.has(joinPath(dir, move.to)))
          deps.log(`would move ${escapeName(move.from)} -> ${escapeName(move.to)}`);
      for (const path of moduleSwitch?.removes ?? []) deps.log(`would remove ${escapeName(path)}`);
      for (const path of blocked) deps.error(`WOULD REFUSE: ${escapeName(path)} already exists`);
      const planned = await reportDryRunPlan(deps, formatted);
      const code = blocked.size > 0 ? EXIT_ERROR : planned;
      reportAdoptions(adoptions, 'Would adopt', deps.error);
      renderGenerateFindings(
        moduleSwitch?.writes.some((file) => file.path === 'setu.config.ts') === true
          ? withoutRegistrationWiring(diagnosis)
          : diagnosis,
        deps.error,
        { dryRun: true, ...(module === undefined ? {} : { module }) },
      );
      return code;
    }
    const write = (fs: IFileSystem): ReturnType<typeof writeFiles> =>
      writeFiles(
        fs,
        formatted,
        deps.interrupt === undefined ? { root: dir } : { root: dir, signal: deps.interrupt },
      );
    const outcomes =
      moduleSwitch === undefined
        ? await write(deps.fs)
        : await applyModuleSwitch(deps, dir, moduleSwitch, write);
    for (const outcome of outcomes) deps.log(`${outcome.outcome} ${escapeName(outcome.path)}`);
    if (schematicName === 'migration' && customName === undefined) {
      deps.log(
        `Add readiness: { migrations: MIGRATION_NAMES } from ./src/migrations/index.ts to DatabasePlugin(...) and create the setu_migrations table: ${repositoryFileUrl('packages/database-plugin/README.md#migrations-and-readiness')}`,
      );
    }
    if (installed.has('validation-plugin') && ['module', 'schema'].includes(schematicName)) {
      let hasZod = false;
      for (const manifest of project.manifests) {
        const read = await readJsonManifest(deps.fs, manifest.path);
        if (read.kind !== 'ok' || typeof read.value !== 'object' || read.value === null) continue;
        for (const field of ['imports', 'dependencies', 'devDependencies']) {
          const entries = (read.value as Record<string, unknown>)[field];
          if (typeof entries === 'object' && entries !== null && Object.hasOwn(entries, 'zod'))
            hasZod = true;
        }
      }
      if (!hasZod)
        deps.log(
          `Install Zod: ${runtime === 'deno' ? 'deno add npm:zod@^4.6.6' : runtime === 'bun' ? 'bun add zod@^4.6.6' : 'npm install zod@^4.6.6'}`,
        );
    }
    // After the write, so a refused or failed run never reports a claim it did not
    // make. Reported once — the next scan finds the file in the barrel — because the
    // alternative, a provenance marker in the artifact, would un-wire every artifact
    // in every project generated before this release.
    reportAdoptions(adoptions, 'Adopted', deps.error);
    // The barrel is managed and now lists the artifact, but the developer's config
    // may never have consumed it — an inline project generated before the seam
    // existed, or a starter-composed one whose decorators arm was never filled in.
    // The CLI cannot edit that config (M101g), so it prints the exact line instead
    // of letting the file appear wired when nothing registers it.
    // The switch rewrote the config's registration lines, so the wiring read
    // before the write is stale: read the project again.
    renderGenerateFindings(
      moduleSwitch === undefined ? diagnosis : await diagnoseProject(deps.fs, dir, installed),
      deps.error,
      {
        generated: generated.map((file) => file.path),
        ...(module === undefined ? {} : { module }),
      },
    );
    // Only a `--module` run asks whether the module is active; a run that wrote
    // the activation barrel is covered by the wiring projection above, so the two
    // never print for the same run.
    if (declarationAdvice !== undefined) deps.log(declarationAdvice);
    if (module !== undefined && mode === 'class-based' && schematicName === 'service') {
      deps.log(`Inject it with @Inject('${serviceSeamToken(`${module}.${names.kebab}`)}').`);
    }
  } catch (cause) {
    const interrupted = interruptionMessage(cause);
    if (interrupted !== undefined) {
      deps.error(interrupted);
      return EXIT_INTERRUPTED;
    }
    deps.error(
      `${dryRun ? 'Cannot plan' : 'Failed to write'}: ${escapeName(cause instanceof Error ? cause.message : String(cause))}`,
    );
    return EXIT_ERROR;
  }

  return EXIT_OK;
}

/**
 * Reports each file a generated barrel claimed that the CLI did not write.
 *
 * @param adoptions - The claims into barrels this command writes
 * @param verb - `Adopted`, or `Would adopt` for a dry run
 * @param error - The command's error channel
 */
function reportAdoptions(
  adoptions: readonly AdoptedArtifact[],
  verb: 'Adopted' | 'Would adopt',
  error: (message: string) => void,
): void {
  for (const claim of adoptions) {
    error(
      `${verb} ${escapeName(claim.path)} into ${escapeName(claim.barrel)}: it matches this ` +
        `family's naming convention, so the generated barrel registers it.`,
    );
    error(`  Remove any manual registration of it, or rename the file.`);
  }
}

/**
 * The declaration array a class generated into a class-based module joins.
 *
 * `g route` writes a function controller, which the module's managed index
 * registers instead, so it has no declaration entry.
 *
 * @param schematicName - The schematic being run
 * @param names - The artifact's derived names
 * @returns The property, class and import specifier, or undefined
 */
function moduleDeclarationTarget(
  schematicName: string,
  names: DerivedNames,
): { property: ModuleDeclarationProperty; symbol: string; specifier: string } | undefined {
  if (schematicName === 'service')
    return {
      property: 'providers',
      symbol: `${names.pascal}Service`,
      specifier: `./${names.kebab}.service.ts`,
    };
  if (schematicName === 'controller' || schematicName === 'sse')
    return {
      property: 'controllers',
      symbol: `${names.pascal}Controller`,
      specifier: `./${names.kebab}.controller.ts`,
    };
  return undefined;
}

/** Schematics whose artifact lives in `src/controllers`/`src/services` or in a module. */
const PLACED_SCHEMATICS: readonly string[] = ['controller', 'route', 'service', 'sse'];

/**
 * Applies the flat-to-modular switch and the module's files as one transaction:
 * a failure anywhere restores every moved, removed and written file.
 *
 * @param deps - The command's filesystem, interrupt and log
 * @param dir - The project root
 * @param plan - The planned switch
 * @param write - Writes the module's files through the journaled filesystem
 * @returns The write outcomes
 */
async function applyModuleSwitch(
  deps: GenerateDependencies,
  dir: string,
  plan: IModuleSwitch,
  write: (fs: IFileSystem) => ReturnType<typeof writeFiles>,
): ReturnType<typeof writeFiles> {
  const encoder = new TextEncoder();
  // Reported only once everything is written: a failure restores every move.
  const done: string[] = [];
  const outcomes = await withFileTransaction(
    deps.fs,
    async (fs) => {
      for (const move of plan.moves) {
        const to = joinPath(dir, move.to);
        await fs.mkdir(to.slice(0, to.lastIndexOf('/')), { recursive: true });
        await fs.writeFile(
          to,
          typeof move.contents === 'string' ? encoder.encode(move.contents) : move.contents,
        );
        await fs.rm(joinPath(dir, move.from));
        done.push(`moved ${escapeName(move.from)} -> ${escapeName(move.to)}`);
      }
      for (const path of plan.removes) {
        await fs.rm(joinPath(dir, path));
        done.push(`removed ${escapeName(path)}`);
      }
      await pruneAdoptedDirectories(fs, dir, plan.prune);
      if (plan.exampleAdopted)
        done.push(
          "moved the scaffold's untouched greeting example into the module; its routes keep their URLs",
        );
      return await write(fs);
    },
    deps.interrupt,
  );
  for (const line of done) deps.log(line);
  return outcomes;
}

/**
 * Drops the registration-line wiring findings a planned config switch resolves,
 * so a dry run does not report lines the real run would write.
 *
 * @param diagnosis - The diagnosis read before the switch
 * @returns The diagnosis without those findings
 */
function withoutRegistrationWiring(diagnosis: ProjectDiagnosis): ProjectDiagnosis {
  const switched = (finding: ProjectDiagnosis['findings'][number]): boolean =>
    finding.kind === 'unwired' &&
    ['src/modules/index.ts', 'src/controllers/index.ts', 'src/services/index.ts'].includes(
      finding.barrel,
    );
  return {
    ...diagnosis,
    findings: diagnosis.findings.filter((finding) => !switched(finding)),
    generateWiring: diagnosis.generateWiring.filter((finding) => !switched(finding)),
    moduleWiring: diagnosis.moduleWiring.filter((finding) => !switched(finding)),
  };
}
