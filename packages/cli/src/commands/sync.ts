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
        const files = new Map<string, GeneratedFile>();
        const plan = (path: string, contents: string): void => {
          files.set(path, { path: joinPath(dir, path), contents, managed: true });
        };
        for (const spec of scanSeamSpecs(installed)) {
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
