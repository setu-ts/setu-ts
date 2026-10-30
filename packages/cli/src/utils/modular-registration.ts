/**
 * Switches a generated `setu.config.ts` from the flat layout to modules.
 *
 * A flat project registers `src/controllers/index.ts` (and, class-based,
 * `src/services/index.ts`); a modular one registers only `src/modules/index.ts`.
 * `setu g module` is the one place that switches, and this is the edit it makes.
 *
 * Every edit replaces or removes a WHOLE line the CLI itself wrote, matched on
 * comment-masked text so a commented-out copy never counts. A line that is
 * missing or appears more than once, or a flat symbol still referenced after
 * the edit, means the developer has changed the config: the editor returns
 * `undefined` and the caller prints the lines to change instead.
 *
 * @module
 */
import { maskComments, referencesIdentifier } from '../devtool/sources.ts';
import type { GeneratorMode } from './generator-mode.ts';

const CONTROLLERS_IMPORT = {
  functional: "import { registerGeneratedRoutes } from './src/controllers/index.ts';",
  'class-based':
    "import { APP_CONTROLLERS, registerGeneratedRoutes } from './src/controllers/index.ts';",
} as const;
const SERVICES_IMPORT = "import { APP_SERVICES } from './src/services/index.ts';";
const MODULES_IMPORT = {
  functional: "import { registerModules } from './src/modules/index.ts';",
  'class-based': "import { MODULES, registerModules } from './src/modules/index.ts';",
} as const;
const OLD_MODULES_IMPORT = "import { MODULES } from './src/modules/index.ts';";
const ROUTES_CALL = 'registerGeneratedRoutes(app.router, app.services);';
const MODULES_CALL = 'registerModules(app.router, app.services);';
const CONTROLLERS_OPTION = 'controllers: [...APP_CONTROLLERS],';
const SERVICES_OPTION = 'services: [...APP_SERVICES],';
const MODULES_OPTION = 'modules: [...MODULES],';

/** The lines the switch changes, for guidance when the editor declines. */
export interface IModularRegistrationGuidance {
  readonly remove: readonly string[];
  readonly add: readonly string[];
}

/**
 * The lines a config must lose and gain, for the printed guidance.
 *
 * @param mode - The project's generator mode
 * @returns The lines to remove and add
 */
export function modularRegistrationGuidance(mode: GeneratorMode): IModularRegistrationGuidance {
  return mode === 'class-based'
    ? {
        remove: [
          CONTROLLERS_IMPORT['class-based'],
          SERVICES_IMPORT,
          CONTROLLERS_OPTION,
          SERVICES_OPTION,
          ROUTES_CALL,
        ],
        add: [
          MODULES_IMPORT['class-based'],
          `DecoratorPlugin({ ${MODULES_OPTION} … })`,
          MODULES_CALL,
        ],
      }
    : {
        remove: [CONTROLLERS_IMPORT.functional, ROUTES_CALL],
        add: [MODULES_IMPORT.functional, MODULES_CALL],
      };
}

/**
 * Finds the indices of the lines whose trimmed, comment-masked text is `line`.
 *
 * @param visible - The config's lines with comments masked
 * @param line - The exact statement to find
 * @returns Every matching line index
 */
function linesOf(visible: readonly string[], line: string): readonly number[] {
  return visible.flatMap((text, index) => (text.trim() === line ? [index] : []));
}

/**
 * Rewrites the flat registration lines of a generated config to the modular ones.
 *
 * @param source - The current `setu.config.ts`
 * @param mode - The project's generator mode
 * @returns The edited config, or undefined when its shape is not the generated one
 */
export function withModularRegistration(source: string, mode: GeneratorMode): string | undefined {
  const masked = maskComments(source);
  if (masked === undefined) return undefined;
  const lines = source.split('\n');
  const visible = masked.split('\n');
  const indent = (index: number): string => /^[ \t]*/.exec(lines[index]!)![0];
  // A replaced line keeps the original's line ending.
  const ending = (index: number): string => (lines[index]!.endsWith('\r') ? '\r' : '');

  // Each edit names one line that must occur exactly once (`replace`), or at
  // most once when its replacement may already be present (`ensure`).
  const edits = new Map<number, string | null>();
  const replaceOnce = (line: string, next: string | null): boolean => {
    const found = linesOf(visible, line);
    if (found.length !== 1 || edits.has(found[0]!)) return false;
    edits.set(found[0]!, next === null ? null : `${indent(found[0]!)}${next}${ending(found[0]!)}`);
    return true;
  };
  const present = (line: string): number => linesOf(visible, line).length;

  const modulesImport = MODULES_IMPORT[mode];
  const ok = [
    // The controllers import becomes the modules import, unless the config
    // already imports the modules barrel, which then carries the bindings.
    present(modulesImport) === 1
      ? replaceOnce(CONTROLLERS_IMPORT[mode], null)
      : mode === 'class-based' && present(OLD_MODULES_IMPORT) === 1
        ? replaceOnce(CONTROLLERS_IMPORT[mode], null) &&
          replaceOnce(OLD_MODULES_IMPORT, modulesImport)
        : present(modulesImport) === 0 && replaceOnce(CONTROLLERS_IMPORT[mode], modulesImport),
    present(MODULES_CALL) === 1
      ? replaceOnce(ROUTES_CALL, null)
      : present(MODULES_CALL) === 0 && replaceOnce(ROUTES_CALL, MODULES_CALL),
    ...(mode === 'class-based'
      ? [
          replaceOnce(SERVICES_IMPORT, null),
          replaceOnce(SERVICES_OPTION, null),
          present(MODULES_OPTION) === 1
            ? replaceOnce(CONTROLLERS_OPTION, null)
            : present(MODULES_OPTION) === 0 && replaceOnce(CONTROLLERS_OPTION, MODULES_OPTION),
        ]
      : []),
  ].every(Boolean);
  if (!ok) return undefined;

  const edited = lines
    .flatMap((line, index) => {
      if (!edits.has(index)) return [line];
      const next = edits.get(index)!;
      return next === null ? [] : [next];
    })
    .join('\n');
  // A flat binding still in use means the developer referenced it elsewhere;
  // removing its import would break the config.
  const after = maskComments(edited);
  if (
    after === undefined ||
    ['registerGeneratedRoutes', 'APP_CONTROLLERS', 'APP_SERVICES'].some((symbol) =>
      referencesIdentifier(after, symbol),
    )
  )
    return undefined;
  return edited;
}
