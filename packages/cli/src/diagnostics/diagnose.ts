/** The read-only owner of generated-project diagnostics. @module */
import type { IFileSystem } from '@setu-ts/common';
import type { ArtifactScanAll } from '../utils/artifact-scanner.ts';
import { scanArtifacts } from '../utils/artifact-scanner.ts';
import { scanModuleArtifacts, scanModules } from '../utils/module-scanner.ts';
import { generatorMode, type GeneratorMode } from '../utils/generator-mode.ts';
import { scanSeamSpecs } from '../seams/registry.ts';
import { FUNCTIONAL_CONTROLLERS_SEAM, FUNCTIONAL_ROUTES_SEAM } from '../seams/http.ts';
import { legacyRegistrarNotice, readLegacyHttpFiles } from '../utils/legacy-layout.ts';
import { joinPath } from '../utils/file-writer.ts';
import { diagnoseBarrels, readBarrel } from './barrel-drift.ts';
import { moduleActive, moduleSymbol, withoutImports } from './modules.ts';
import { maskSourceCode } from '../devtool/sources.ts';
import { wiringFinding, wiringSites } from './wiring.ts';
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
      readonly reason: 'not-a-file' | 'too-large' | 'unclassifiable';
    }
  | {
      readonly kind: 'config-unreadable';
      readonly path: string;
      readonly reason: 'not-a-file' | 'too-large' | 'unclassifiable';
    }
  | { readonly kind: 'check-config-invalid'; readonly path: string; readonly entry: string }
  | { readonly kind: 'silence-unmatched'; readonly entry: string };

/** Raw generator inputs plus read-only diagnostics and legacy reporting projections. */
export interface ProjectDiagnosis {
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
  const specs = scanSeamSpecs(installed);
  const scan =
    options?.module === undefined || mode === 'class-based'
      ? await scanArtifacts(scanFs, dir, specs)
      : await scanModuleArtifacts(scanFs, dir, options.module);
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
  const legacy = await readLegacyHttpFiles(fs, dir);
  if (legacy.length > 0) findings.push({ kind: 'legacy-layout', files: legacy });
  if (legacyRegistrarNotice(config).length > 0) findings.push({ kind: 'legacy-registrar' });
  // `generate` reports what it always reported; an unreadable artifact is check's.
  const generateFindings = findings.filter((finding) => finding.kind !== 'artifact-unreadable');
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
      const symbol = mode === 'class-based' ? 'MODULES' : 'registerModules';
      const code = withoutImports(maskSourceCode(config));
      if (code === undefined || !new RegExp(`\\b${symbol}\\b`).test(code))
        moduleWiring.push({
          kind: 'unwired',
          barrel: 'src/modules/index.ts',
          symbols: [symbol],
          site: mode === 'class-based' ? 'modules' : 'registerModules',
          outcome: code === undefined ? 'unclassifiable' : 'unwired',
        });
    }
    if (mode !== 'functional') continue;
    const internal = await scanModuleArtifacts(scanFs, dir, module);
    moduleArtifacts.set(module, internal.artifacts);
    if (options?.module === undefined) addScan(internal);
    const moduleDir = `src/modules/${module}`;
    findings.push(
      ...(await diagnoseBarrels(
        fs,
        dir,
        [FUNCTIONAL_CONTROLLERS_SEAM, FUNCTIONAL_ROUTES_SEAM].map((spec) => ({
          ...spec,
          dir: moduleDir,
          barrel: `${moduleDir}/index.ts`,
        })),
        internal.artifacts,
      )),
    );
  }
  const starter = composingStarter(config);
  return {
    ...(starter === undefined ? {} : { starter }),
    mode,
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
