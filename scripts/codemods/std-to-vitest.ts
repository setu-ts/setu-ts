// Reproducible package-test conversion. Usage: node scripts/codemods/std-to-vitest.ts [--write|--check]
/* eslint-disable no-console -- repository command-line tooling */
// Rewrites only what maps 1:1; everything else is REPORTED, never guessed.
import ts from 'typescript';
import { writeFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { expect as vitestExpect } from 'vitest';

type Edit = { start: number; end: number; text: string };
type Finding = { file: string; line: number; kind: string; detail: string };

const BDD = '@std/testing/bdd';
const EXPECT = '@std/expect';
const BDD_MAP: Record<string, string> = {
  describe: 'describe',
  it: 'it',
  test: 'test',
  beforeEach: 'beforeEach',
  afterEach: 'afterEach',
  beforeAll: 'beforeAll',
  afterAll: 'afterAll',
};
const EXPECT_MAP: Record<string, string> = { expect: 'expect' };
const DROPPED_OPTIONS = new Set([
  'sanitizeOps',
  'sanitizeResources',
  'sanitizeExit',
  'permissions',
]);
const KEPT_OPTIONS = new Set(['timeout']);

// Matcher names Vitest's expect actually exposes (walk the assertion's prototype chain + chai props).
const vitestMatchers = new Set<string>();
{
  let o: object | null = vitestExpect(1) as object;
  while (o) {
    for (const k of Object.getOwnPropertyNames(o)) vitestMatchers.add(k);
    o = Object.getPrototypeOf(o);
  }
}

/** Convert only imported test bindings, reporting unsupported forms rather than guessing. */
export function convertFiles(files: string[], write = false) {
  const findings: Finding[] = [];
  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);
  let changedFiles = 0;
  const denoFiles = new Set<string>();

  const program = ts.createProgram(files, {
    noResolve: true,
    noLib: true,
    allowJs: false,
    jsx: ts.JsxEmit.Preserve,
    types: [],
  });
  const checker = program.getTypeChecker();
  const boundToImport = (id: ts.Identifier): boolean => {
    const sym = checker.getSymbolAtLocation(id);
    const decl = sym?.declarations?.[0];
    return decl !== undefined && ts.isImportSpecifier(decl);
  };
  for (const file of files) {
    const sf = program.getSourceFile(file)!;
    const text = sf.text;
    const edits: Edit[] = [];
    const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const report = (n: ts.Node, kind: string, detail: string) => {
      findings.push({ file, line: line(n), kind, detail });
      bump(kind);
    };

    // --- A. imports -------------------------------------------------------------------------
    const valueNames = new Set<string>();
    const typeNames = new Set<string>();
    const local = new Set<string>(); // local identifiers bound to bdd functions
    let insertAt = -1;
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const mod = stmt.moduleSpecifier.text;
      if (mod.startsWith('@std/') && mod !== BDD && mod !== EXPECT) {
        report(stmt, 'unmapped-module', mod);
        continue;
      }
      if (mod === 'vitest') {
        const bindings = stmt.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const binding of bindings.elements) {
            if ((binding.propertyName ?? binding.name).text in BDD_MAP)
              local.add(binding.name.text);
          }
        }
      }
      if (mod !== BDD && mod !== EXPECT) continue;
      const map = mod === BDD ? BDD_MAP : EXPECT_MAP;
      const clause = stmt.importClause;
      const named =
        clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings
          : undefined;
      if (!clause || clause.name || !named) {
        report(stmt, 'unmapped-import-shape', stmt.getText(sf));
        continue;
      }
      let ok = true;
      for (const el of named.elements) {
        const imported = (el.propertyName ?? el.name).text;
        const target = map[imported];
        if (!target) {
          report(el, 'unmapped-name', `${mod}:${imported}`);
          ok = false;
          continue;
        }
        const spelled = el.propertyName ? `${target} as ${el.name.text}` : target;
        (clause.isTypeOnly || el.isTypeOnly ? typeNames : valueNames).add(spelled);
        if (mod === BDD) local.add(el.name.text);
      }
      if (!ok) continue;
      if (insertAt < 0) insertAt = stmt.getStart(sf);
      // Remove the declaration including its trailing newline.
      let end = stmt.getEnd();
      if (text[end] === '\n') end++;
      edits.push({ start: stmt.getStart(sf), end, text: '' });
    }
    if (insertAt >= 0) {
      const parts = [...[...valueNames].sort(), ...[...typeNames].sort().map((n) => `type ${n}`)];
      edits.push({
        start: insertAt,
        end: insertAt,
        text: `import { ${parts.join(', ')} } from 'vitest';\n`,
      });
    }

    // --- B. call forms ------------------------------------------------------------------------
    const rootName = (e: ts.Expression): string | undefined => {
      if (ts.isIdentifier(e)) return boundToImport(e) ? e.text : undefined;
      if (ts.isPropertyAccessExpression(e)) return rootName(e.expression);
      return undefined;
    };
    const rewrittenOptions = new Set<ts.Node>();
    const rewriteOptions = (obj: ts.ObjectLiteralExpression): { empty: boolean; local: Edit[] } => {
      if (rewrittenOptions.has(obj)) return { empty: false, local: [] };
      rewrittenOptions.add(obj);
      let kept = 0;
      const out: Edit[] = [];
      const edits = out;
      for (const p of obj.properties) {
        const key =
          p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
            ? p.name.text
            : undefined;
        if (
          key === 'ignore' &&
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))
        ) {
          const value = ts.isPropertyAssignment(p) ? p.initializer.getText(sf) : 'ignore';
          edits.push({ start: p.getStart(sf), end: p.getEnd(), text: `skip: ${value}` });
          bump('rewrite:ignore->skip');
          kept++;
        } else if (key && DROPPED_OPTIONS.has(key)) {
          let end = p.getEnd();
          if (text[end] === ',') end++;
          edits.push({ start: p.getFullStart(), end, text: '' });
          report(p, `dropped-option:${key}`, p.getText(sf).replace(/\s+/g, ' ').slice(0, 160));
        } else if (key && KEPT_OPTIONS.has(key)) {
          kept++;
        } else {
          report(p, 'unmapped-option', p.getText(sf).slice(0, 120));
          kept++;
        }
      }
      return { empty: kept === 0, local: out };
    };

    const visit = (n: ts.Node): void => {
      if (
        ts.isStringLiteral(n) &&
        ((ts.isImportDeclaration(n.parent) && n.parent.moduleSpecifier === n) ||
          (ts.isCallExpression(n.parent) &&
            n.parent.expression.kind === ts.SyntaxKind.ImportKeyword) ||
          (ts.isLiteralTypeNode(n.parent) && ts.isImportTypeNode(n.parent.parent)))
      ) {
        const bare = bareSpecifier(n.text);
        if (bare !== n.text)
          edits.push({ start: n.getStart(sf), end: n.getEnd(), text: `'${bare}'` });
      }
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const root = rootName(callee);
        if (root && local.has(root)) {
          // it.ignore -> it.skip ; it.only reported
          if (ts.isPropertyAccessExpression(callee)) {
            const m = callee.name.text;
            if (m === 'ignore') {
              edits.push({
                start: callee.name.getStart(sf),
                end: callee.name.getEnd(),
                text: 'skip',
              });
              bump('rewrite:.ignore->.skip');
            } else if (m === 'only') report(callee, 'only', callee.getText(sf));
            else if (m !== 'skip') report(callee, 'unmapped-modifier', callee.getText(sf));
          }
          const base = ts.isIdentifier(callee) ? callee.text : undefined;
          const a = n.arguments;
          if (a.length === 1 && ts.isObjectLiteralExpression(a[0]!)) {
            // it({ name, fn, ...opts }) -> it(name, { opts }, fn)
            const obj = a[0]!;
            let nameT: string | undefined;
            let fnNode: ts.ObjectLiteralElementLike | undefined;
            const rest: string[] = [];
            let bad = false;
            for (const p of obj.properties) {
              const key = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
              if (key === 'name' && ts.isPropertyAssignment(p)) nameT = p.initializer.getText(sf);
              else if (
                key === 'fn' &&
                (ts.isPropertyAssignment(p) ||
                  (ts.isMethodDeclaration(p) && !p.parameters.length && p.body))
              )
                fnNode = p;
              else if (key === 'ignore' && ts.isPropertyAssignment(p)) {
                rest.push(`skip: ${p.initializer.getText(sf)}`);
                bump('rewrite:ignore->skip');
              } else if (key && DROPPED_OPTIONS.has(key))
                report(p, `dropped-option:${key}`, p.getText(sf).slice(0, 160));
              else if (key && KEPT_OPTIONS.has(key) && ts.isPropertyAssignment(p))
                rest.push(p.getText(sf));
              else {
                report(p, 'unmapped-option', p.getText(sf).slice(0, 120));
                bad = true;
              }
            }
            const last = obj.properties[obj.properties.length - 1];
            if (nameT && fnNode && !bad && fnNode === last) {
              const opts = rest.length ? `{ ${rest.join(', ')} }, ` : '';
              if (ts.isPropertyAssignment(fnNode)) {
                edits.push({
                  start: obj.getStart(sf),
                  end: fnNode.initializer.getStart(sf),
                  text: `${nameT}, ${opts}`,
                });
                edits.push({ start: fnNode.initializer.getEnd(), end: obj.getEnd(), text: '' });
              } else if (ts.isMethodDeclaration(fnNode) && fnNode.body) {
                const isAsync = fnNode.modifiers?.some(
                  (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
                );
                edits.push({
                  start: obj.getStart(sf),
                  end: fnNode.body.getStart(sf),
                  text: `${nameT}, ${opts}${isAsync ? 'async ' : ''}() => `,
                });
                edits.push({ start: fnNode.body.getEnd(), end: obj.getEnd(), text: '' });
              }
              bump('rewrite:object-form');
            } else if (!bad) report(obj, 'unmapped-object-form', 'missing name/fn or fn not last');
          }
          if (a.length === 2 && ts.isObjectLiteralExpression(a[0]!)) {
            // it({ name, ...opts }, fn) -> it(name, { opts }, fn)
            const obj = a[0]!;
            let nameT: string | undefined;
            const rest: string[] = [];
            let bad = false;
            for (const p of obj.properties) {
              const key = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
              if (key === 'name' && ts.isPropertyAssignment(p)) nameT = p.initializer.getText(sf);
              else if (key === 'ignore' && ts.isPropertyAssignment(p)) {
                rest.push(`skip: ${p.initializer.getText(sf)}`);
                bump('rewrite:ignore->skip');
              } else if (key && DROPPED_OPTIONS.has(key))
                report(p, `dropped-option:${key}`, p.getText(sf).slice(0, 160));
              else if (key && KEPT_OPTIONS.has(key) && ts.isPropertyAssignment(p))
                rest.push(p.getText(sf));
              else {
                report(p, 'unmapped-option', p.getText(sf).slice(0, 120));
                bad = true;
              }
            }
            if (nameT && !bad) {
              edits.push({
                start: obj.getStart(sf),
                end: obj.getEnd(),
                text: rest.length ? `${nameT}, { ${rest.join(', ')} }` : nameT,
              });
              bump('rewrite:options-first-form');
            } else if (!bad) report(obj, 'unmapped-object-form', 'options-first form without name');
          }
          if (a.length === 3 && ts.isIdentifier(a[1]!)) {
            const declaration = checker.getSymbolAtLocation(a[1]!)?.declarations?.[0];
            if (
              declaration &&
              ts.isVariableDeclaration(declaration) &&
              declaration.initializer &&
              ts.isObjectLiteralExpression(declaration.initializer)
            ) {
              edits.push(...rewriteOptions(declaration.initializer).local);
            }
          }
          if (a.length === 3 && ts.isObjectLiteralExpression(a[1]!)) {
            const { empty, local } = rewriteOptions(a[1]!);
            if (empty) edits.push({ start: a[0]!.getEnd(), end: a[2]!.getStart(sf), text: ', ' });
            else edits.push(...local);
          }
          // Deno's it() passes a TestContext; Vitest passes its own context.
          const fn = a[a.length - 1];
          if (
            base &&
            base !== 'describe' &&
            fn &&
            (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
            fn.parameters.length
          )
            report(fn, 'test-context-param', fn.parameters.map((p) => p.getText(sf)).join(', '));
        }
        // --- C. matchers ------------------------------------------------------------------------
        if (ts.isPropertyAccessExpression(callee)) {
          const m = callee.name.text;
          if (/^to[A-Z]/.test(m) && isExpectChain(callee.expression)) {
            if (!vitestMatchers.has(m)) report(callee.name, 'unknown-matcher', m);
            if ((m === 'toThrow' || m === 'toThrowError') && n.arguments.length > 1)
              report(n, 'toThrow-two-args', n.getText(sf).replace(/\s+/g, ' ').slice(0, 140));
          }
        }
      }
      // --- C2. unawaited async assertions (Deno accepts these silently; they assert nothing) ----
      if (ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)) {
        let e: ts.Expression = n.expression.expression;
        let async = false;
        while (ts.isPropertyAccessExpression(e)) {
          if (e.name.text === 'rejects' || e.name.text === 'resolves') async = true;
          e = e.expression;
        }
        if (
          async &&
          ts.isCallExpression(e) &&
          ts.isIdentifier(e.expression) &&
          e.expression.text === 'expect'
        )
          report(n, 'unawaited-async-assertion', n.getText(sf).replace(/\s+/g, ' ').slice(0, 120));
      }
      // --- C3. matchers whose semantics differ (measured on both runners); review, not rewrite --
      if (ts.isPropertyAccessExpression(n) && n.name.text === 'toStrictEqual')
        bump('review:toStrictEqual');
      if (
        ts.isPropertyAccessExpression(n) &&
        n.name.text === 'toContain' &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'not'
      )
        bump('review:not.toContain');
      // --- D. Deno.* --------------------------------------------------------------------------
      if (
        ts.isPropertyAccessExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'Deno'
      ) {
        bump('deno-api:' + n.name.text);
        denoFiles.add(file);
      }
      ts.forEachChild(n, visit);
    };
    const isExpectChain = (e: ts.Expression): boolean => {
      if (ts.isCallExpression(e))
        return ts.isIdentifier(e.expression) && e.expression.text === 'expect';
      if (ts.isPropertyAccessExpression(e)) return isExpectChain(e.expression);
      return false;
    };
    visit(sf);

    if (edits.length) {
      edits.sort((x, y) => y.start - x.start || y.end - x.end);
      let out = text;
      let lastStart = Infinity;
      for (const e of edits) {
        if (e.end > lastStart) {
          report(sf, 'overlapping-edit', `${e.start}-${e.end}`);
          continue;
        }
        out = out.slice(0, e.start) + e.text + out.slice(e.end);
        lastStart = e.start;
      }
      if (out !== text) {
        changedFiles++;
        if (write) writeFileSync(file, out);
      }
    }
  }

  return { files: files.length, changedFiles, denoFiles: [...denoFiles].sort(), counts, findings };
}

/** Test-side registry specifiers become Node names; both Zod majors keep their identity. */
export function bareSpecifier(spec: string): string {
  const match = /^(?:npm:|jsr:)(@[^/]+\/[^@/]+|[^@/]+)(?:@([^/]+))?(\/.*)?$/.exec(spec);
  if (!match) return spec;
  let name = match[1]!;
  if (name === 'zod' && match[2]) {
    if (/^\^?3/.test(match[2])) name = 'zod-v3';
    else if (/^\^?4/.test(match[2])) name = 'zod-v4';
  }
  if (name === '@hono/hono') name = 'hono';
  return name + (match[3] ?? '');
}

/** Include helper modules as well as test files, without entering generated artifacts. */
export function testSources(directory = 'packages'): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist'].includes(entry.name)) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...testSources(path));
    else if (/\/test\/.*\.tsx?$/.test(path)) files.push(path);
  }
  return files.sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const report = convertFiles(testSources(), args.includes('--write'));
  if (args.includes('--check')) {
    const failures = report.findings.filter((f) => f.kind === 'unawaited-async-assertion');
    for (const f of failures) console.error(`${f.file}:${f.line}: ${f.detail}`);
    process.exitCode = failures.length ? 1 : 0;
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}
