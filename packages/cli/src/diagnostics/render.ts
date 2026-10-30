/** Plain diagnostic rendering; generate's historic stderr stays pinned. @module */
import type { Finding, ProjectDiagnosis } from './diagnose.ts';
import { findingId, findingPath } from './ids.ts';
import { STARTER_SEAMS, starterSeamLiteral } from '../templates/seam.ts';
import { STARTER_ARMS } from '../utils/starter-arms.ts';
import { escapeName } from '../utils/names.ts';
import { legacyLayoutNotice, legacyRegistrarNotice } from '../utils/legacy-layout.ts';

function lines(finding: Finding): readonly string[] {
  const f = finding;
  switch (f.kind) {
    case 'module-rejected':
      return [
        `Skipped ${escapeName(f.path)}: its name is not a kebab-case identifier, so it cannot be listed in the activation barrel. Rename the directory.`,
      ];
    case 'module-skipped':
      return [
        `Skipped ${escapeName(f.path)}: it is missing ${escapeName(f.missing)}, so it cannot be listed in the ${f.mode === 'class-based' ? 'MODULES' : 'registerModules'} activation barrel.`,
        `  Add ${escapeName(f.missing)}${f.legacy ? ' with @Module(...)' : ' as an export'} or delete and regenerate the module.`,
      ];
    case 'artifact-invalid':
      return [
        `Skipped ${escapeName(f.path)}: its name is not a kebab-case identifier, so it cannot be listed in the barrel. Rename the file.`,
      ];
    case 'artifact-skipped':
      return [
        `Skipped ${escapeName(f.path)}: it does not export ${escapeName(f.missing.join(', '))}, so it cannot be listed in the generated barrel and nothing registers it.`,
        '  Add that export to the file — or rename an existing one — or delete the file and run this schematic again.',
      ];
    case 'manual-registration':
      return [
        `Skipped ${escapeName(f.path)}: ${escapeName(f.symbol)} is already registered by hand in ${escapeName(f.wiredIn)}, so listing it in the generated barrel would register it twice.`,
        '  Remove the manual registration to let the barrel own it, or leave it as it is.',
      ];
    case 'legacy-layout':
      return legacyLayoutNotice(f.files);
    case 'legacy-registrar':
      return legacyRegistrarNotice('registerGeneratedRoutes(app.router)');
    case 'module-inactive':
      return [
        `Module "${escapeName(f.module)}" is not activated in src/modules/index.ts, so its routes are unreachable; add:`,
        f.mode === 'class-based'
          ? `  import { ${f.symbol} } from './${f.module}/${f.module}.module.ts';`
          : `  import { ${f.symbol} } from './${f.module}/index.ts';`,
        f.mode === 'class-based' ? `  ${f.symbol} in MODULES` : `  ${f.symbol}(router, services);`,
      ];
    case 'unwired': {
      const symbol = f.symbols.join(', ');
      if (f.site === 'registerModules')
        return [
          'setu.config.ts does not reference registerModules; add:',
          "  import { registerModules } from './src/modules/index.ts';",
          '  registerModules(app.router, app.services);',
        ];
      const seam = STARTER_SEAMS.find((entry) => entry.barrel === f.barrel);
      const owner = STARTER_ARMS.find((entry) => entry.symbol === f.starter);
      const starterAdvice =
        seam !== undefined && owner?.arms.has(seam.plugin) === true
          ? [
              `${f.starter} owns ${seam.plugin === 'queue-plugin' ? 'QueuePlugin' : seam.plugin === 'events-plugin' ? 'EventsPlugin' : 'CqrsPlugin'}; merge the barrel into its ${seam.arm} arm:`,
              `  ${seam.arm}: ${starterSeamLiteral(seam)}`,
            ]
          : undefined;
      const result =
        starterAdvice ??
        (f.site === 'processors'
          ? [`Pass the barrel to QueuePlugin: QueuePlugin({ processors: [...${symbol}] })`]
          : f.site === 'config'
            ? [`setu.config.ts does not reference ${symbol}; consume the barrel exports:`]
            : f.starter !== undefined && f.site !== 'modules'
              ? [
                  `${f.starter} owns DecoratorPlugin; merge the barrel into its decorators arm:`,
                  `  decorators: { ${f.site}: [...${symbol}] }`,
                ]
              : [
                  `setu.config.ts does not reference ${symbol}; add it to DecoratorPlugin:`,
                  `  ${f.site}: [...${symbol}]`,
                ]);
      return [...result, `  import { ${symbol} } from './${f.barrel}';`];
    }
    case 'barrel-drift':
      return [
        `${escapeName(f.barrel)} has barrel drift: unlisted ${escapeName(f.unlisted.join(', ')) || '(none)'}; stale ${escapeName(f.stale.join(', ')) || '(none)'}.`,
        `  Run \`setu sync\` to rewrite ${escapeName(f.barrel)} from ${escapeName(f.barrel.slice(0, f.barrel.lastIndexOf('/')))}.`,
      ];
    case 'barrel-unreadable':
      return [
        `Cannot check ${escapeName(f.barrel)}: ${f.reason}.`,
        '  Restore a regular, classifiable barrel under 1 MiB, then run `setu sync`.',
      ];
    case 'artifact-unreadable':
      if (['unsafe-directory', 'depth-limit', 'unreadable-directory'].includes(f.reason))
        return [
          `Skipped directory ${escapeName(f.path)}: ${f.reason === 'unsafe-directory' ? 'its path cannot be verified without following a link inside the project' : f.reason === 'depth-limit' ? 'it exceeds the scan limit of 8 subdirectories' : 'it cannot be read'}.`,
          '  Restore an ordinary readable directory within the scan limit; `setu sync` preserves its barrel until then.',
        ];
      return [
        `Cannot read ${escapeName(f.path)}: ${f.reason}, so whether it is wired cannot be checked.`,
        '  Restore a regular, readable file under 1 MiB; `setu sync` will not rewrite its barrel until then.',
      ];
    case 'config-unreadable':
      return [
        `Cannot read ${escapeName(f.path)}: ${f.reason}, so its wiring cannot be checked.`,
        '  Restore a regular, readable setu.config.ts under 1 MiB.',
      ];
    case 'no-config':
      return [
        `No setu.config.ts; cannot check wiring for ${escapeName(f.barrels.join(', '))}.`,
        '  Import and consume these barrels in your application wiring.',
      ];
    case 'check-config-invalid':
      return [`Invalid ${escapeName(f.path)}: ${escapeName(f.entry)}. Nothing was silenced.`];
    case 'mixed-layout':
      return [
        `This project has modules and also keeps controllers or services outside them: ${escapeName(f.files.join(', '))}.`,
        '  A project keeps them in one place: move them into a module, then run `setu sync`.',
      ];
    case 'unresolved-import':
      return [
        `${escapeName(f.path)} imports ${escapeName(f.specifier)}, which does not exist.`,
        '  Run `setu sync` to rewrite it from the files present, or restore the file.',
      ];
    case 'duplicate-name':
      return [
        `Two ${escapeName(f.family)} files share a base name and would bind one symbol: ${escapeName(f.paths.join(', '))}.`,
        '  Rename one of them.',
      ];
    case 'silence-unmatched':
      return [
        `Silence entry ${escapeName(f.entry)} matched no finding.`,
        '  Remove the stale entry from .setu-ts/check.json.',
      ];
  }
}

/** Renders the generator's pre-write reports or its planned-barrel/module notices. */
export function renderGenerateFindings(
  diagnosis: ProjectDiagnosis,
  error: (line: string) => void,
  options?: {
    readonly generated?: readonly string[];
    readonly module?: string;
    readonly dryRun?: boolean;
  },
): void {
  if (options === undefined) {
    for (const finding of diagnosis.generateFindings) {
      if (
        [
          'module-rejected',
          'module-skipped',
          'artifact-invalid',
          'artifact-skipped',
          'artifact-unreadable',
          'manual-registration',
          'legacy-layout',
          'legacy-registrar',
          'mixed-layout',
        ].includes(finding.kind)
      )
        for (const line of lines(finding)) error(line);
    }
    return;
  }
  if (options.dryRun !== true) {
    // Functional module wiring has always preceded the decorator/jobs sites.
    const findings = diagnosis.generateWiring.filter(
      (f) => 'barrel' in f && options.generated?.includes(f.barrel),
    );
    for (const finding of [
      ...findings.filter((f) => f.kind === 'unwired' && f.site === 'registerModules'),
      ...findings.filter((f) => f.kind !== 'unwired' || f.site !== 'registerModules'),
    ])
      for (const line of lines(finding)) error(line);
  }
  if (options.module !== undefined) {
    const inactive = diagnosis.findings.find(
      (f) => f.kind === 'module-inactive' && f.module === options.module,
    );
    for (const finding of inactive === undefined ? diagnosis.moduleWiring : [inactive])
      for (const line of lines(finding)) error(line);
  }
}

/** Prints sorted check findings and returns the effective error/warning counts. */
export function renderCheckFindings(
  findings: readonly Finding[],
  error: (line: string) => void,
  strict = false,
): { readonly errors: number; readonly warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const finding of [...findings].sort(
    (a, b) => findingPath(a).localeCompare(findingPath(b)) || a.kind.localeCompare(b.kind),
  )) {
    const id = findingId(finding);
    const severity = id.startsWith('setu.E') ? 'error' : 'warning';
    if (severity === 'error' || strict) errors++;
    else warnings++;
    const rendered = lines(finding);
    error(
      `${severity} ${id}: ${rendered[0]}${finding.kind === 'unwired' ? ` (${finding.barrel}${finding.outcome === 'unclassifiable' ? '; config is unclassifiable' : ''})` : ''}`,
    );
    for (const line of rendered.slice(1)) error(line);
  }
  return { errors, warnings };
}

/**
 * Prints the duplicate-name refusal a writing command stops on, in the words the
 * scan used before it became a finding.
 *
 * @param diagnosis - The project's diagnosis
 * @param error - The command's error channel
 * @returns True when a duplicate was found and the command must stop
 */
export function refuseDuplicateNames(
  diagnosis: ProjectDiagnosis,
  error: (line: string) => void,
): boolean {
  let found = false;
  for (const finding of diagnosis.findings)
    if (finding.kind === 'duplicate-name') {
      found = true;
      error(
        `Duplicate ${escapeName(finding.family)} base name: ${finding.paths.map(escapeName).join(', ')}. Rename one file before generating or syncing.`,
      );
    }
  return found;
}
