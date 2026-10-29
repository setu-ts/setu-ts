/** Compiler API proof used by the full-stack options test, without coverage instrumentation. */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GeneratedFile } from '../../src/utils/file-writer.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const project = `${root}.tmp/m121-typecheck`;
const input = JSON.parse(readFileSync(0, 'utf8')) as readonly GeneratedFile[];
const files = new Map(input.map((file) => [`${project}/${file.path}`, file.contents]));
const config = ts.readConfigFile(`${root}tsconfig.check.json`, ts.sys.readFile);
const base = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
const options: ts.CompilerOptions = {
  ...base,
  // Removing the annotation leaves its type import unused; this proof isolates
  // excess-property checking. Generated ~/ imports are checked without emit.
  noUnusedLocals: false,
  rewriteRelativeImportExtensions: false,
  types: ['node', `${root}packages/runtime/node_modules/@types/deno`],
  paths: { ...base.paths, '~/*': [`${project}/app/*`] },
};
const host = ts.createCompilerHost(options);
const readFile = host.readFile.bind(host);
const fileExists = host.fileExists.bind(host);
const directoryExists = host.directoryExists!.bind(host);
host.readFile = (path) => files.get(path) ?? readFile(path);
host.fileExists = (path) => files.has(path) || fileExists(path);
host.directoryExists = (path) => path.startsWith(project) || directoryExists(path);
const getSourceFile = host.getSourceFile.bind(host);
const sources = new Map<string, ts.SourceFile>();
host.getSourceFile = (path, language, onError, fresh) => {
  const virtual = files.get(path);
  const cached = sources.get(path);
  if (cached !== undefined && (virtual === undefined || cached.text === virtual)) return cached;
  const source =
    virtual === undefined
      ? getSourceFile(path, language, onError, fresh)
      : ts.createSourceFile(path, virtual, language);
  if (source !== undefined) sources.set(path, source);
  return source;
};
let previous: ts.Program | undefined;
function diagnostics(): readonly { readonly code: number; readonly message: string }[] {
  previous = ts.createProgram([`${project}/setu.config.ts`], options, host, previous);
  return ts.getPreEmitDiagnostics(previous).map((item) => ({
    code: item.code,
    message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
  }));
}
const path = `${project}/setu.config.ts`;
const source = files.get(path)!;
const valid = diagnostics();
// Queue-only arms also exercise the requested misspelled messaging key.
const withMessaging = source.includes('messaging:')
  ? source
  : source.replace('return {', "return { messaging: { broker: 'memory' },");
files.set(path, withMessaging.replace('messaging:', 'messagin:'));
const misspelled = diagnostics();
files.set(path, files.get(path)!.replace(': FullStackStarterOptions =>', ' =>'));
const unannotated = diagnostics();
console.log(JSON.stringify({ valid, misspelled, unannotated }));
