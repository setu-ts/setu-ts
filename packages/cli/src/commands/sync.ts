/** Rewrites only CLI-managed barrels using their schematic renderers. @module */
import { stringFlag, type ParsedArgs } from '../args.ts';
import { forEachProject, type ICheckDependencies } from './check.ts';
import { diagnoseProject } from '../diagnostics/diagnose.ts';
import { renderCheckFindings } from '../diagnostics/render.ts';
import { readSilence } from '../diagnostics/silence.ts';
import { detectPlugins } from '../utils/plugin-detector.ts';
import { detectTargetRuntime } from '../utils/runtime-detector.ts';
import { scanSeamSpecs } from '../seams/registry.ts';
import { renderFunctionalModuleBarrel, renderFunctionalModuleIndex } from '../seams/modules.ts';
import { renderModuleBarrel } from '../schematics/module-barrel.ts';
import { deriveNames, escapeName } from '../utils/names.ts';
import {
  joinPath,
  reportDryRunPlan,
  resolveDir,
  writeFiles,
  type GeneratedFile,
} from '../utils/file-writer.ts';
import { formatForTarget } from '../utils/prettier-format.ts';
import { interruptionMessage } from '../utils/interruption.ts';
import { EXIT_ERROR, EXIT_INTERRUPTED, EXIT_OK } from '../constants.ts';

/** Plans, formats and transactionally writes the same barrels as generate. */
export async function runSyncCommand(args: ParsedArgs, deps: ICheckDependencies): Promise<number> {
  if (args.flags.help === true || args.flags.h === true) {
    deps.log('Usage: setu sync [--dir <path>] [--dry-run]');
    deps.log('  --dir <path>  Sync this project or workspace instead of the CWD');
    deps.log('  --dry-run     Print the barrel plan, write nothing');
    return EXIT_OK;
  }
  return await forEachProject(
    resolveDir(deps.cwd, stringFlag(args.flags, 'dir')),
    deps,
    async (dir, deps) => {
      try {
        const installed = await detectPlugins(deps.fs, dir);
        const diagnosis = await diagnoseProject(deps.fs, dir, installed);
        // Hand registrations are read from `setu.config.ts`; without it the scan cannot
        // tell which artifacts a barrel must leave out, and a rewrite could register one
        // twice. So nothing is written, whatever a silence entry says about E012.
        if (diagnosis.findings.some((finding) => finding.kind === 'config-unreadable')) {
          const result = await readSilence(deps.fs, dir, diagnosis.findings);
          renderCheckFindings(result.findings, deps.error);
          deps.error(
            'setu sync wrote nothing: setu.config.ts cannot be read, so hand registrations cannot be checked.',
          );
          return EXIT_ERROR;
        }
        const files = new Map<string, GeneratedFile>();
        const plan = (path: string, contents: string): void => {
          files.set(path, { path: joinPath(dir, path), contents, managed: true });
        };
        // A barrel whose family holds an artifact that could not be read is left as
        // it is: rewriting it from the scan would drop an import nobody can verify
        // (M118 audit F7). The E013 finding printed below names the file.
        const unreadable = diagnosis.findings.flatMap((finding) =>
          finding.kind === 'artifact-unreadable' ? [finding.path] : [],
        );
        const held = new Set(
          scanSeamSpecs(installed)
            .filter((spec) =>
              unreadable.some(
                (path) => path.startsWith(`${spec.dir}/`) && path.endsWith(spec.suffix),
              ),
            )
            .map((spec) => spec.barrel),
        );
        for (const spec of scanSeamSpecs(installed)) {
          if (held.has(spec.barrel)) continue;
          if (
            diagnosis.presentBarrels.has(spec.barrel) ||
            (diagnosis.artifacts[spec.schematic]?.length ?? 0) > 0
          )
            plan(spec.barrel, spec.renderBarrel(diagnosis.artifacts));
        }
        if (diagnosis.presentBarrels.has('src/modules/index.ts') || diagnosis.modules.length > 0)
          plan(
            'src/modules/index.ts',
            diagnosis.mode === 'class-based'
              ? renderModuleBarrel(diagnosis.modules, diagnosis.legacyModules)
              : renderFunctionalModuleBarrel(diagnosis.modules),
          );
        for (const [module, artifacts] of diagnosis.moduleArtifacts)
          if (!unreadable.some((path) => path.startsWith(`src/modules/${module}/`)))
            plan(
              `src/modules/${module}/index.ts`,
              renderFunctionalModuleIndex(deriveNames(module), {
                controller: artifacts.controller,
                route: artifacts.route,
              }),
            );
        const formatted = await formatForTarget(
          [...files.values()],
          await detectTargetRuntime(deps.fs, dir),
          dir,
          deps.error,
        );
        if (args.flags['dry-run'] === true) return reportDryRunPlan(deps, formatted);
        const outcomes = await writeFiles(deps.fs, formatted, {
          root: dir,
          ...(deps.interrupt === undefined ? {} : { signal: deps.interrupt }),
        });
        for (const outcome of outcomes) deps.log(`${outcome.outcome} ${escapeName(outcome.path)}`);
        const result = await readSilence(
          deps.fs,
          dir,
          (await diagnoseProject(deps.fs, dir, installed)).findings,
        );
        const counts = renderCheckFindings(result.findings, deps.error);
        return counts.errors > 0 ? EXIT_ERROR : EXIT_OK;
      } catch (cause) {
        const interrupted = interruptionMessage(cause);
        if (interrupted !== undefined) {
          deps.error(interrupted);
          return EXIT_INTERRUPTED;
        }
        deps.error(
          `Cannot sync ${escapeName(dir)}: ${escapeName(cause instanceof Error ? cause.message : String(cause))}`,
        );
        return EXIT_ERROR;
      }
    },
  );
}
