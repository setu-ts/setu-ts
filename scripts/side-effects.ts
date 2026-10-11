/** The manifest sideEffects audit; initializers remain a documented heuristic gap. @module */
import ts from 'typescript';
import { posix } from 'node:path';
import { maskNonCode } from './npm-specifier-audit.ts';

/** Approved effect modules and the reason a bundler must retain them. */
export const SIDE_EFFECT_MODULES: Readonly<Record<string, string>> = {
  'packages/decorator-plugin/src/metadata/symbol-metadata.ts':
    'Installs Symbol.metadata write-if-absent before TC39 decorated class definition (M111a).',
};

/** One source finding, including the target of an effect-only import. */
export interface SideEffectFinding {
  readonly file: string;
  readonly module: string;
  readonly kind: 'expression' | 'import' | 'static-block';
}

/** Masks non-code and finds expression statements, effect imports and static blocks.
 * Unapproved effects and stale approvals are refusals. Imports approve their target,
 * rather than making a pure decorator module itself non-tree-shakeable.
 */
export function auditSideEffects(
  files: ReadonlyMap<string, string>,
): { readonly findings: readonly SideEffectFinding[]; readonly refusals: readonly string[] } {
  const findings: SideEffectFinding[] = [];
  for (const [file, source] of files) {
    const masked = maskNonCode(source);
    // Parse the intact syntax: masking template interpolation delimiters is
    // length-preserving but is not a syntactically valid TypeScript transform.
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const localLets = new Set<string>();
    for (const statement of tree.statements) {
      if (
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Let) !== 0
      ) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) localLets.add(declaration.name.text);
        }
      }
    }
    for (const statement of tree.statements) {
      if (
        ts.isExpressionStatement(statement) &&
        masked.code.slice(statement.getStart(tree), statement.end).trim() !== ''
      ) findings.push({ file, module: file, kind: 'expression' });
      if (ts.isImportDeclaration(statement) && statement.importClause === undefined) {
        const literal = source.slice(
          statement.moduleSpecifier.getStart(tree) + 1,
          statement.moduleSpecifier.end - 1,
        );
        const module = literal.startsWith('.')
          ? posix.normalize(posix.join(posix.dirname(file), literal))
          : literal;
        findings.push({ file, module, kind: 'import' });
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isClassStaticBlockDeclaration(node)) {
        const local = node.body.statements.every((statement) => {
          if (
            !ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)
          ) return false;
          const assignment = statement.expression;
          return assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(assignment.left) && localLets.has(assignment.left.text) &&
            (ts.isArrowFunction(assignment.right) || ts.isFunctionExpression(assignment.right));
        });
        if (!local) findings.push({ file, module: file, kind: 'static-block' });
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  const refusals = findings.filter((f) => !Object.hasOwn(SIDE_EFFECT_MODULES, f.module))
    .map((f) => `${f.file}: unlisted ${f.kind} effect in ${f.module}`);
  for (const module of Object.keys(SIDE_EFFECT_MODULES)) {
    if (files.has(module) && !findings.some((f) => f.module === module && f.kind !== 'import')) {
      refusals.push(`${module}: stale sideEffects approval`);
    }
  }
  return { findings, refusals };
}
