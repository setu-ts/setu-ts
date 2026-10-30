/**
 * Plans the one switch from the flat layout to modules: the first `setu g module`.
 *
 * A project has one home for routes and services at a time (`project-layout.ts`).
 * Flat keeps them in `src/controllers/` and `src/services/`; modular keeps them in
 * `src/modules/<name>/`. The first module therefore has to take the flat files
 * with it, or refuse:
 *
 * - With nothing flat but the empty barrels, it removes the barrels and switches
 *   the config's registration lines (`modular-registration.ts`).
 * - With flat files, it refuses and names them, unless `--adopt-controllers`
 *   asks it to move them into the new module. Moving keeps relative subfolders,
 *   rewrites every relative import into and out of the moved files, lists the
 *   adopted controllers and services in the module's registration, and leaves
 *   their URL paths alone.
 *
 * Everything is planned before anything is written, and a file whose imports
 * cannot be read exactly (`import-specifiers.ts`) refuses the whole switch, so
 * the project is never left half-moved. The caller applies the plan inside one
 * file transaction.
 *
 * @module
 */
import type { IFileSystem } from '@setu-ts/common';
import { maskComments, referencesIdentifier } from '../devtool/sources.ts';
import { readBarrel } from '../diagnostics/barrel-drift.ts';
import { controllerClassSymbol, FUNCTION_CONTROLLER_ARTIFACTS } from '../seams/http.ts';
import { renderClassModuleIndex, renderFunctionalModuleIndex } from '../seams/modules.ts';
import { seamNames, type SeamArtifacts } from '../seams/seam-spec.ts';
import { walkProjectFiles } from '../workspace/adopt.ts';
import { artifactNames, normalizeRelative } from './artifact-path.ts';
import { assertInsideProject, joinPath, type GeneratedFile } from './file-writer.ts';
import type { GeneratorMode } from './generator-mode.ts';
import { readImportSpecifiers, type ISpecifierSpan } from './import-specifiers.ts';
import { modularRegistrationGuidance, withModularRegistration } from './modular-registration.ts';
import { withModuleDeclarationEntry } from './module-declaration.ts';
import { deriveNames, escapeName } from './names.ts';
import { REST_SHOWCASE_FILES } from '../templates/rest-showcase.ts';
import { CLASS_BASED_SHOWCASE_EXAMPLE } from '../templates/class-based-showcase.ts';

/** The scaffold's greeting example, in both styles. */
const SCAFFOLD_EXAMPLE: readonly GeneratedFile[] = [
  ...REST_SHOWCASE_FILES,
  ...CLASS_BASED_SHOWCASE_EXAMPLE.files,
];

/** Source with formatting removed: the scaffold's formatter may reflow the example. */
function unformatted(source: string): string {
  return source.replace(/,(\s*[)\]}])/g, '$1').replace(/\s+/g, '');
}

/**
 * Whether the flat files are exactly the scaffold's greeting example, as written.
 *
 * Moving them needs no consent: nothing in them is the developer's. One edit, one
 * extra file, or one unreadable file and the switch asks for `--adopt-controllers`.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project root
 * @param flat - The flat files, project-relative
 * @returns True when every flat file is an untouched example file
 */
async function onlyUntouchedExample(
  fs: IFileSystem,
  dir: string,
  flat: readonly string[],
): Promise<boolean> {
  const decoder = new TextDecoder();
  for (const path of flat) {
    let source: string;
    try {
      source = decoder.decode(await fs.readFile(joinPath(dir, path)));
    } catch {
      return false;
    }
    if (
      !SCAFFOLD_EXAMPLE.some(
        (file) => file.path === path && unformatted(file.contents) === unformatted(source),
      )
    )
      return false;
  }
  return true;
}

/** The flat homes, relative to the project root. */
const FLAT_DIRS: readonly string[] = ['src/controllers', 'src/services'];
/** The flat barrels the switch removes. */
const FLAT_BARRELS: readonly string[] = ['src/controllers/index.ts', 'src/services/index.ts'];
/** The bindings a flat config imports from those barrels. */
const FLAT_BINDINGS: readonly string[] = [
  'registerGeneratedRoutes',
  'APP_CONTROLLERS',
  'APP_SERVICES',
];

/** One file the switch moves, with its rewritten contents. */
export interface IModuleSwitchMove {
  /** Path relative to the project root. */
  readonly from: string;
  /** Destination relative to the project root. */
  readonly to: string;
  /** The contents to write at `to`: the original bytes, or its text with imports rewritten. */
  readonly contents: string | Uint8Array;
}

/** Everything the switch writes, moves and removes. */
export interface IModuleSwitch {
  readonly moves: readonly IModuleSwitchMove[];
  /** Project-relative writes, all overwritable: module files, config, importers. */
  readonly writes: readonly GeneratedFile[];
  /** Project-relative files removed: the emptied flat barrels. */
  readonly removes: readonly string[];
  /** The flat directories to remove once empty. */
  readonly prune: readonly string[];
  /** The flat files were only the untouched scaffold example, moved without `--adopt-controllers`. */
  readonly exampleAdopted: boolean;
}

/** The planner's answer. */
export type ModuleSwitchPlan =
  | { readonly kind: 'switch'; readonly plan: IModuleSwitch }
  | { readonly kind: 'refused'; readonly lines: readonly string[] };

/** What the planner needs from the generate command. */
export interface IModuleSwitchInput {
  readonly fs: IFileSystem;
  /** The project root (absolute). */
  readonly dir: string;
  /** The new module's kebab name. */
  readonly module: string;
  readonly mode: GeneratorMode;
  /** `--adopt-controllers` was passed. */
  readonly adopt: boolean;
  /** The flat scan: `controller`, its function shapes, and `service`. */
  readonly artifacts: SeamArtifacts;
  /** The module schematic's files, project-relative. */
  readonly generated: readonly GeneratedFile[];
  /** How to name the CLI in advice, e.g. `npx setu`. */
  readonly cli: string;
}

/** Posix `dirname` for project-relative paths. */
function dirname(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

/**
 * The relative specifier from one directory to a project path.
 *
 * @param fromDir - The importing file's directory, project-relative
 * @param target - The imported path, project-relative
 * @returns A specifier beginning with `./` or `../`
 */
function relativeSpecifier(fromDir: string, target: string): string {
  const from = fromDir === '' ? [] : fromDir.split('/');
  const to = target.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  const up = from.length - shared;
  const rest = to.slice(shared).join('/');
  return up === 0 ? `./${rest}` : `${'../'.repeat(up)}${rest}`;
}

/**
 * Whether `source` references a flat binding. A config the comment mask cannot
 * classify is read as plain text, which can only over-report.
 *
 * @param source - The config
 * @returns True when a flat binding appears
 */
function referencesFlatBinding(source: string): boolean {
  const visible = maskComments(source);
  return FLAT_BINDINGS.some((name) =>
    visible === undefined ? source.includes(name) : referencesIdentifier(visible, name),
  );
}

/**
 * Plans the switch from flat to modular for the first `setu g module`.
 *
 * @param input - The project, the module and the module schematic's output
 * @returns The plan, or the lines explaining a refusal
 */
export async function planModuleSwitch(input: IModuleSwitchInput): Promise<ModuleSwitchPlan> {
  const { fs, dir, module, mode } = input;
  const exists = async (path: string): Promise<'file' | 'directory' | undefined> => {
    try {
      const stat = await fs.stat(joinPath(dir, path));
      return stat.isDirectory ? 'directory' : 'file';
    } catch {
      return undefined;
    }
  };

  const flat: string[] = [];
  for (const home of FLAT_DIRS)
    if ((await exists(home)) === 'directory')
      for (const path of await walkProjectFiles(fs, dir, home))
        if (!FLAT_BARRELS.includes(path)) flat.push(path);
  flat.sort();
  const barrels: string[] = [];
  for (const barrel of FLAT_BARRELS) if ((await exists(barrel)) === 'file') barrels.push(barrel);

  // The scaffold's own example, untouched, moves without being asked.
  const exampleAdopted =
    flat.length > 0 && !input.adopt && (await onlyUntouchedExample(fs, dir, flat));
  if (flat.length > 0 && !input.adopt && !exampleAdopted)
    return {
      kind: 'refused',
      lines: [
        `Cannot create the first module while controllers or services live outside modules; a project keeps them in one place:`,
        ...flat.map((path) => `  ${escapeName(path)}`),
        `Move them into src/modules/${module}/ with \`${input.cli} g module ${module} --adopt-controllers\` (their URLs stay the same),`,
        `or move them into a module by hand and run \`${input.cli} sync\`.`,
      ],
    };

  // The config's registration lines switch with the layout.
  const configRead = await readBarrel(fs, joinPath(dir, 'setu.config.ts'));
  if (configRead.kind === 'unreadable')
    return {
      kind: 'refused',
      lines: [`Cannot read setu.config.ts (${configRead.reason}); nothing was changed.`],
    };
  const original = configRead.kind === 'source' ? configRead.source : undefined;
  const edited = original === undefined ? undefined : withModularRegistration(original, mode);
  if (original !== undefined && edited === undefined && referencesFlatBinding(original)) {
    const guidance = modularRegistrationGuidance(mode);
    return {
      kind: 'refused',
      lines: [
        'setu.config.ts registers src/controllers/ in a shape the CLI does not edit, so nothing was changed.',
        'Switch it to modules by hand, then run this command again:',
        ...guidance.remove.map((line) => `  remove: ${line}`),
        ...guidance.add.map((line) => `  add:    ${line}`),
      ],
    };
  }

  const prefix = `src/modules/${module}`;
  const moved = new Map<string, string>(
    flat.map((path) => [path, `${prefix}/${path.slice(path.indexOf('/', 4) + 1)}`]),
  );
  const generatedPaths = new Set(input.generated.map((file) => file.path));
  const seen = new Map<string, string>();
  const clashes: string[] = [];
  for (const [from, to] of moved) {
    if (generatedPaths.has(to) || seen.has(to))
      clashes.push(`  ${escapeName(from)} -> ${escapeName(to)}`);
    seen.set(to, from);
  }
  if (clashes.length > 0)
    return {
      kind: 'refused',
      lines: [
        `Cannot adopt into src/modules/${module}/: these would land on the same file as another file or the module's own:`,
        ...clashes,
        'Rename them, or choose another module name; nothing was moved.',
      ],
    };

  // Every file that can import a moved file or a removed barrel. A file whose
  // text names none of them cannot, so it is not read.
  const stems = [...moved.keys()].map((path) =>
    path.slice(path.lastIndexOf('/') + 1).replace(/\.tsx?$/, ''),
  );
  const sources = new Map<string, string>();
  // Keep a byte-order mark: a moved file must differ only in its rewritten imports.
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  if (moved.size > 0 || barrels.length > 0) {
    const candidates: string[] = [];
    for (const root of ['src', 'test'])
      if ((await exists(root)) === 'directory')
        candidates.push(...(await walkProjectFiles(fs, dir, root)));
    if (original !== undefined) candidates.push('setu.config.ts');
    for (const path of candidates) {
      if (!/\.tsx?$/.test(path) || barrels.includes(path)) continue;
      const text =
        path === 'setu.config.ts'
          ? (edited ?? original!)
          : decoder.decode(await fs.readFile(joinPath(dir, path)));
      if (
        moved.has(path) ||
        /controllers|services/.test(text) ||
        stems.some((stem) => text.includes(stem))
      )
        sources.set(path, text);
    }
  }
  const read = await readImportSpecifiers(sources);
  if (read.kind === 'unclassifiable')
    return {
      kind: 'refused',
      lines: [
        `Cannot rewrite the imports of ${escapeName(read.path)}: ${read.reason}. Nothing was moved.`,
        `Move the files into src/modules/${module}/ by hand and run \`${input.cli} sync\`.`,
      ],
    };

  const moves: IModuleSwitchMove[] = [];
  const writes: GeneratedFile[] = [];
  for (const [path, spans] of read.spans) {
    const source = sources.get(path)!;
    const from = moved.get(path) ?? path;
    const edits: { readonly span: ISpecifierSpan; readonly value: string }[] = [];
    for (const span of spans) {
      if (!span.value.startsWith('./') && !span.value.startsWith('../')) continue;
      const target = normalizeRelative(`${dirname(path)}/${span.value}`);
      if (
        FLAT_DIRS.includes(target) ||
        barrels.some((barrel) => barrel === target || barrel === `${target}.ts`)
      )
        return {
          kind: 'refused',
          lines: [
            `${escapeName(path)} imports ${escapeName(span.value)}, a flat barrel the first module removes. Nothing was changed.`,
            'Import the files it re-exports directly, then run this command again.',
          ],
        };
      // An extensionless or directory specifier keeps its form.
      const match = ['', '.ts', '.tsx', '/index.ts'].find((suffix) =>
        moved.has(`${target}${suffix}`),
      );
      if (match === undefined && from === path) continue;
      const destination =
        match === undefined
          ? target
          : moved.get(`${target}${match}`)!.slice(0, match === '' ? undefined : -match.length);
      const value = relativeSpecifier(dirname(from), destination);
      if (value !== span.value) edits.push({ span, value });
    }
    let contents = source;
    for (const { span, value } of [...edits].sort((a, b) => b.span.start - a.span.start)) {
      const quote = source[span.start]!;
      contents = `${contents.slice(0, span.start)}${quote}${value}${quote}${contents.slice(span.end)}`;
    }
    if (moved.has(path)) moves.push({ from: path, to: from, contents });
    else if (path !== 'setu.config.ts' && contents !== source)
      writes.push({ path, contents, managed: true });
    else if (path === 'setu.config.ts' && contents !== original)
      writes.push({ path, contents, managed: true });
  }
  // Moved files nobody had to read (no imports at all) still move, byte for byte.
  for (const [path, to] of moved)
    if (!moves.some((move) => move.from === path))
      moves.push({ from: path, to, contents: await fs.readFile(joinPath(dir, path)) });
  if (edited !== undefined && !writes.some((file) => file.path === 'setu.config.ts'))
    writes.push({ path: 'setu.config.ts', contents: edited, managed: true });

  for (const move of moves) {
    await assertInsideProject(fs, dir, joinPath(dir, move.from));
    await assertInsideProject(fs, dir, joinPath(dir, move.to));
  }

  const adopted = adoptedRegistration(input, moved);
  if (adopted.kind === 'refused') return adopted;
  return {
    kind: 'switch',
    plan: {
      moves: moves.sort((a, b) => a.from.localeCompare(b.from)),
      writes: [...adopted.files, ...writes],
      removes: barrels,
      prune: FLAT_DIRS,
      exampleAdopted,
    },
  };
}

/**
 * Lists the adopted controllers and services in the new module's registration.
 *
 * Functional: the managed index registers every controller. Class-based: the
 * `@Module` declaration lists the class controllers and services, and the
 * managed index registers the function controllers.
 *
 * @param input - The planner input
 * @param moved - Old path → new path
 * @returns The module schematic's files with registration updated
 */
function adoptedRegistration(
  input: IModuleSwitchInput,
  moved: ReadonlyMap<string, string>,
):
  | { readonly kind: 'ok'; readonly files: readonly GeneratedFile[] }
  | { readonly kind: 'refused'; readonly lines: readonly string[] } {
  const names = deriveNames(input.module);
  const prefix = `src/modules/${input.module}`;
  const within = (family: string, dir: string): string[] =>
    seamNames(input.artifacts, family).filter((name) =>
      moved.has(`${dir}/${name}${family === 'service' ? '.service.ts' : '.controller.ts'}`),
    );
  const controllers = within('controller', 'src/controllers');
  const functions =
    input.mode === 'functional'
      ? controllers
      : within(FUNCTION_CONTROLLER_ARTIFACTS, 'src/controllers');
  const services = input.mode === 'functional' ? [] : within('service', 'src/services');
  const files: GeneratedFile[] = [];
  for (const file of input.generated) {
    if (file.path === `${prefix}/index.ts`) {
      files.push({
        ...file,
        contents:
          input.mode === 'functional'
            ? renderFunctionalModuleIndex(names, {
                controller: [input.module, ...controllers],
              })
            : renderClassModuleIndex(names, {
                controller: [input.module, ...controllers],
                [FUNCTION_CONTROLLER_ARTIFACTS]: functions,
              }),
      });
    } else if (file.path === `${prefix}/${input.module}.module.ts`) {
      let source = file.contents;
      const entries = [
        ...controllers
          .filter((name) => !functions.includes(name))
          .map((name) => ({
            property: 'controllers' as const,
            symbol: controllerClassSymbol(artifactNames(name)),
            specifier: `./${name}.controller.ts`,
          })),
        ...services.map((name) => ({
          property: 'providers' as const,
          symbol: `${artifactNames(name).pascal}Service`,
          specifier: `./${name}.service.ts`,
        })),
      ];
      for (const entry of entries) {
        const edit = withModuleDeclarationEntry(
          source,
          entry.property,
          entry.symbol,
          entry.specifier,
        );
        // `present` means the module's own class has this name: the adopted one
        // would never be registered.
        if (edit.kind !== 'edited')
          return {
            kind: 'refused',
            lines: [
              `Cannot list ${escapeName(entry.symbol)} in the new module's declaration: another class of that name is already bound there. Nothing was moved.`,
            ],
          };
        source = edit.source;
      }
      files.push({ ...file, contents: source });
    } else files.push(file);
  }
  return { kind: 'ok', files };
}
