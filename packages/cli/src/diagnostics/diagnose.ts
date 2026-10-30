/** The read-only owner of generated-project diagnostics. @module */
import type { IFileSystem } from '@setu-ts/common';
import type { ArtifactScanAll, UnreadableArtifact } from '../utils/artifact-scanner.ts';
import { DuplicateArtifactNameError, scanArtifacts } from '../utils/artifact-scanner.ts';
import { lexImportSpecifiers } from '../utils/import-specifiers.ts';
import { normalizeRelative } from '../utils/artifact-path.ts';
import { scanModuleArtifacts, scanModules } from '../utils/module-scanner.ts';
import { generatorMode, type GeneratorMode } from '../utils/generator-mode.ts';
import { scanSeamSpecs } from '../seams/registry.ts';
import {
  CONTROLLERS_SEAM,
  FUNCTION_CONTROLLER_ARTIFACTS,
  FUNCTIONAL_CONTROLLERS_SEAM,
} from '../seams/http.ts';
import { legacyRegistrarNotice, readLegacyHttpFiles } from '../utils/legacy-layout.ts';
import { joinPath } from '../utils/file-writer.ts';
import { diagnoseBarrels, readBarrel } from './barrel-drift.ts';
import { moduleActive, moduleSymbol, withoutImports } from './modules.ts';
import { maskSourceCode } from '../devtool/sources.ts';
import { wiringFinding, wiringSites } from './wiring.ts';
import { flatArtifactFiles, projectLayout, type ProjectLayout } from '../utils/project-layout.ts';
import { composingStarter } from '../utils/starter-arms.ts';

/** Typed findings carry facts; renderers own prose and exit policy. */
export type Finding =
  | { readonly kind: 'module-rejected' | 'artifact-invalid'; readonly path: string }
  | {
      readonly kind: 'module-skipped';
      readonly path: string;
      readonly missing: string;
      readonly legacy: boolean;
      readonly mode: GeneratorMode;
    }
  | {
      readonly kind: 'artifact-skipped';
      readonly path: string;
      readonly missing: readonly string[];
    }
  | {
      readonly kind: 'manual-registration';
      readonly path: string;
      readonly symbol: string;
      readonly wiredIn: string;
    }
  | { readonly kind: 'legacy-layout'; readonly files: readonly string[] }
  | { readonly kind: 'legacy-registrar' }
  | {
      readonly kind: 'barrel-drift';
      readonly barrel: string;
      readonly unlisted: readonly string[];
      readonly stale: readonly string[];
    }
  | {
      readonly kind: 'barrel-unreadable';
      readonly barrel: string;
      readonly reason: 'not-a-file' | 'too-large' | 'unclassifiable';
    }
  | {
      readonly kind: 'unwired';
      readonly barrel: string;
      readonly symbols: readonly string[];
      readonly site: string;
      readonly outcome: 'unwired' | 'unclassifiable';
      readonly starter?: string;
    }
  | {
      readonly kind: 'module-inactive';
      readonly module: string;
      readonly symbol: string;
      readonly mode: GeneratorMode;
    }
  | { readonly kind: 'no-config'; readonly barrels: readonly string[] }
  | {
      readonly kind: 'artifact-unreadable';
      readonly path: string;
      readonly reason: UnreadableArtifact['reason'];
    }
  | {
      readonly kind: 'config-unreadable';
      readonly path: string;
      readonly reason: 'not-a-file' | 'too-large' | 'unclassifiable';
    }
  | { readonly kind: 'check-config-invalid'; readonly path: string; readonly entry: string }
  | { readonly kind: 'mixed-layout'; readonly files: readonly string[] }
  | { readonly kind: 'unresolved-import'; readonly path: string; readonly specifier: string }
  | { readonly kind: 'duplicate-name'; readonly family: string; readonly paths: readonly string[] }
  | { readonly kind: 'silence-unmatched'; readonly entry: string };

/** Raw generator inputs plus read-only diagnostics and legacy reporting projections. */
export interface ProjectDiagnosis {
  readonly layout: ProjectLayout;
  readonly starter?: NonNullable<ReturnType<typeof composingStarter>>;
  readonly artifacts: ArtifactScanAll['artifacts'];
  readonly adopted: ArtifactScanAll['adopted'];
  readonly modules: readonly string[];
  readonly legacyModules: readonly string[];
  readonly mode: GeneratorMode;
  readonly findings: readonly Finding[];
  readonly generateFindings: readonly Finding[];
  readonly generateWiring: readonly Finding[];
  readonly moduleWiring: readonly Finding[];
  readonly moduleArtifacts: ReadonlyMap<string, ArtifactScanAll['artifacts']>;
  readonly presentBarrels: ReadonlySet<string>;
  readonly hasSeams: boolean;
}

/** Scans a project without writing, formatting, printing or booting it. */
export async function diagnoseProject(
  fs: IFileSystem,
  dir: string,
  installed: ReadonlySet<string>,
  options?: { readonly module?: string },
): Promise<ProjectDiagnosis> {
  // Read with the barrels' bounded reader so an unreadable config (a directory,
  // a FIFO, a link to a device, over 1 MiB, no permission) stays distinct from
  // an absent one: treating it as absent would drop every wiring finding.
  const configRead = await readBarrel(fs, joinPath(dir, 'setu.config.ts'));
  const config = configRead.kind === 'source' ? configRead.source : '';
  // The existing scanners own admission and hand-registration detection. Supply
  // their config reads from this bounded snapshot, including module scans, so
  // every finding in one diagnosis sees the same wiring and opens it only once.
  const configPath = joinPath(dir, 'setu.config.ts');
  const configBytes = new TextEncoder().encode(config);
  const scanFs: IFileSystem = {
    ...fs,
    stat: (path) =>
      path === configPath
        ? Promise.resolve({ isFile: true, isDirectory: false, size: configBytes.length })
        : fs.stat(path),
    readFile: (path) => (path === configPath ? Promise.resolve(configBytes) : fs.readFile(path)),
  };
  const mode = generatorMode(installed);
  const modules = await scanModules(fs, dir, mode);
  const layout = await projectLayout(fs, dir, modules);
  const specs = scanSeamSpecs(installed);
  const duplicates: Finding[] = [];
  // Two files of one family with one base name would bind one symbol twice. The
  // scan refuses rather than alias them; the diagnosis reports it as E016 and
  // carries an empty scan, so generate and sync refuse instead of writing a
  // barrel that would drop a file.
  const guarded = async (read: () => Promise<ArtifactScanAll>): Promise<ArtifactScanAll> => {
    try {
      return await read();
    } catch (cause) {
      if (!(cause instanceof DuplicateArtifactNameError)) throw cause;
      duplicates.push({ kind: 'duplicate-name', family: cause.family, paths: cause.paths });
      return { artifacts: {}, skipped: [], adopted: [], manual: [], unreadable: [] };
    }
  };
  const scan = await guarded(() =>
    options?.module === undefined
      ? scanArtifacts(scanFs, dir, specs)
      : scanModuleArtifacts(scanFs, dir, options.module, mode),
  );
  const findings: Finding[] = [
    ...modules.rejected.map((path) => ({ kind: 'module-rejected' as const, path })),
    ...modules.skipped.map((skip) => ({
      kind: 'module-skipped' as const,
      path: skip.path,
      missing: skip.missing,
      legacy: skip.kind === 'legacy',
      mode,
    })),
  ];
  const addScan = (value: ArtifactScanAll): void => {
    for (const skip of value.skipped)
      findings.push(
        skip.invalidName === true
          ? { kind: 'artifact-invalid', path: skip.path }
          : { kind: 'artifact-skipped', path: skip.path, missing: skip.missing },
      );
    for (const manual of value.manual) findings.push({ kind: 'manual-registration', ...manual });
    for (const unreadable of value.unreadable)
      findings.push({ kind: 'artifact-unreadable', ...unreadable });
  };
  addScan(scan);
  for (const issue of modules.unreadable ?? [])
    findings.push({ kind: 'artifact-unreadable', ...issue });
  const legacy = await readLegacyHttpFiles(fs, dir);
  if (legacy.length > 0) findings.push({ kind: 'legacy-layout', files: legacy });
  if (legacyRegistrarNotice(config).length > 0) findings.push({ kind: 'legacy-registrar' });
  // File-read failures remain check's; incomplete directory walks are also
  // reported by generate, so a skipped subfolder never disappears silently.
  const generateFindings = findings.filter(
    (finding) =>
      finding.kind !== 'artifact-unreadable' ||
      ['unsafe-directory', 'depth-limit', 'unreadable-directory'].includes(finding.reason),
  );
  findings.push(...(await diagnoseBarrels(fs, dir, specs, scan.artifacts)));
  const presentBarrels = new Set<string>();
  let hasSeams = false;
  for (const path of new Set([
    ...specs.flatMap((spec) => [spec.barrel, spec.dir]),
    'src/modules',
    'src/modules/index.ts',
  ])) {
    try {
      await fs.stat(joinPath(dir, path));
      hasSeams = true;
      presentBarrels.add(path);
    } catch {
      /* Absent seam: an ordinary fresh project. */
    }
  }
  const generateWiring: Finding[] = [];
  for (const [barrel, site] of wiringSites(installed, true)) {
    if (config === '') continue;
    const finding = wiringFinding(config, barrel, site.symbols, site.site);
    if (finding !== undefined) generateWiring.push(finding);
  }
  const wiredBarrels: string[] = [];
  for (const [barrel, site] of wiringSites(installed, false)) {
    if (!presentBarrels.has(barrel)) continue;
    wiredBarrels.push(barrel);
    if (config === '') continue;
    const finding = wiringFinding(config, barrel, site.symbols, site.site);
    if (finding !== undefined) findings.push(finding);
  }
  // A class-based module index registers the module's function controllers,
  // so a class-based config needs registerModules beside MODULES.
  if (mode === 'class-based' && config !== '' && presentBarrels.has('src/modules/index.ts')) {
    const finding = wiringFinding(
      config,
      'src/modules/index.ts',
      ['registerModules'],
      'registerModules',
    );
    if (finding !== undefined) findings.push(finding);
  }
  if (configRead.kind === 'unreadable')
    findings.push({ kind: 'config-unreadable', path: 'setu.config.ts', reason: configRead.reason });
  else if (config === '' && wiredBarrels.length > 0)
    findings.push({ kind: 'no-config', barrels: wiredBarrels });
  const activation = await readBarrel(fs, joinPath(dir, 'src/modules/index.ts'));
  const moduleArtifacts = new Map<string, ArtifactScanAll['artifacts']>();
  const moduleWiring: Finding[] = [];
  for (const module of modules.names) {
    const symbol = moduleSymbol(module, mode);
    if (activation.kind !== 'source' || !moduleActive(activation.source, symbol, mode))
      findings.push({ kind: 'module-inactive', module, symbol, mode });
    else if (config !== '' && options?.module === module) {
      // A class-based config needs both: MODULES for the class controllers and
      // registerModules for each module's function controllers.
      const code = withoutImports(maskSourceCode(config));
      const required: readonly (readonly [symbol: string, site: string])[] =
        mode === 'class-based'
          ? [
              ['MODULES', 'modules'],
              ['registerModules', 'registerModules'],
            ]
          : [['registerModules', 'registerModules']];
      for (const [symbol, site] of required)
        if (code === undefined || !new RegExp(`\\b${symbol}\\b`).test(code))
          moduleWiring.push({
            kind: 'unwired',
            barrel: 'src/modules/index.ts',
            symbols: [symbol],
            site,
            outcome: code === undefined ? 'unclassifiable' : 'unwired',
          });
    }
    const internal = await guarded(() => scanModuleArtifacts(scanFs, dir, module, mode));
    if (options?.module === undefined) {
      addScan(internal);
      for (const issue of internal.unreadable)
        if (['unsafe-directory', 'depth-limit', 'unreadable-directory'].includes(issue.reason))
          generateFindings.push({ kind: 'artifact-unreadable', ...issue });
    }
    moduleArtifacts.set(module, internal.artifacts);
    const moduleDir = `src/modules/${module}`;
    // A class-based index lists only the module's function controllers; its
    // class controllers are listed by the module's own `@Module` declaration.
    const family =
      mode === 'functional'
        ? FUNCTIONAL_CONTROLLERS_SEAM
        : { ...CONTROLLERS_SEAM, schematic: FUNCTION_CONTROLLER_ARTIFACTS };
    findings.push(
      ...(await diagnoseBarrels(
        fs,
        dir,
        [{ ...family, dir: moduleDir, barrel: `${moduleDir}/index.ts` }],
        internal.artifacts,
      )),
    );
  }
  if (layout === 'mixed') {
    // Reported by generate too: it is why a top-level generator now refuses.
    const mixed: Finding = { kind: 'mixed-layout', files: await flatArtifactFiles(fs, dir) };
    findings.push(mixed);
    generateFindings.push(mixed);
  }
  findings.push(...duplicates, ...(await unresolvedImports(fs, dir, modules.names, mode, config)));
  const starter = composingStarter(config);
  return {
    ...(starter === undefined ? {} : { starter }),
    mode,
    layout,
    artifacts: scan.artifacts,
    adopted: scan.adopted,
    modules: modules.names,
    legacyModules: modules.skipped
      .filter((skip) => skip.kind === 'legacy')
      .map((skip) => skip.name),
    findings,
    generateFindings,
    generateWiring,
    moduleWiring,
    moduleArtifacts,
    presentBarrels,
    hasSeams,
  };
}

/**
 * Finds relative imports the CLI wrote that no longer resolve (E015): in the
 * barrels and module indexes it owns, in class-based module declarations it
 * edits, and in the config's registration lines. A moved or deleted file
 * otherwise surfaces only as a type error or a failed boot.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project root
 * @param modules - The admitted modules
 * @param mode - The project's generator mode
 * @param config - The config text, empty when absent
 * @returns One finding per unresolved specifier
 */
async function unresolvedImports(
  fs: IFileSystem,
  dir: string,
  modules: readonly string[],
  mode: GeneratorMode,
  config: string,
): Promise<readonly Finding[]> {
  const files = [
    'src/controllers/index.ts',
    'src/services/index.ts',
    'src/modules/index.ts',
    ...modules.flatMap((module) => [
      `src/modules/${module}/index.ts`,
      ...(mode === 'class-based' ? [`src/modules/${module}/${module}.module.ts`] : []),
    ]),
  ];
  const findings: Finding[] = [];
  const check = async (path: string, source: string, only?: RegExp): Promise<void> => {
    const lexed = lexImportSpecifiers(source);
    if (lexed.kind !== 'ok') return;
    const base = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    for (const span of lexed.spans) {
      if (!span.value.startsWith('./') && !span.value.startsWith('../')) continue;
      if (only !== undefined && !only.test(span.value)) continue;
      try {
        await fs.stat(joinPath(dir, normalizeRelative(`${base}/${span.value}`)));
      } catch {
        findings.push({ kind: 'unresolved-import', path, specifier: span.value });
      }
    }
  };
  for (const path of files) {
    const read = await readBarrel(fs, joinPath(dir, path));
    if (read.kind === 'source') await check(path, read.source);
  }
  // Only the registration lines: the barrels under src/ the CLI wires in.
  if (config !== '') await check('setu.config.ts', config, /^\.\/src\/.*\/index\.ts$/);
  return findings;
}
