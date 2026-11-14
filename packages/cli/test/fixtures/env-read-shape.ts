import ts from 'typescript';

/** A generated environment read, parsed without executing it. */
export interface ParsedEnvRead {
  /** The operator joining the read to its fallback: `||` or `??`. */
  readonly operator: '||' | '??';
  /** The variable read from `runtime.env`. */
  readonly variable: string;
  /** The string literal the read falls back to. */
  readonly fallback: string;
}

/**
 * Parses `runtime.env.X <op> 'fallback'` (optionally inside `Number(...)`) with the
 * TypeScript parser. Nothing is evaluated: the test asserts the operator, and the
 * operator decides whether an empty value falls back (`||`) or wins (`??`).
 *
 * @param expression - The generated expression's source
 * @returns The parsed parts, or undefined when the expression has another shape
 */
export function parseEnvRead(expression: string): ParsedEnvRead | undefined {
  const file = ts.createSourceFile('read.ts', `(${expression});`, ts.ScriptTarget.Latest);
  const statement = file.statements[0];
  if (statement === undefined || !ts.isExpressionStatement(statement)) return undefined;
  let node: ts.Expression = statement.expression;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isCallExpression(node) && node.arguments.length === 1) node = node.arguments[0]!;
  if (!ts.isBinaryExpression(node)) return undefined;
  const kind = node.operatorToken.kind;
  const operator =
    kind === ts.SyntaxKind.BarBarToken
      ? '||'
      : kind === ts.SyntaxKind.QuestionQuestionToken
        ? '??'
        : undefined;
  const { left, right } = node;
  if (
    operator === undefined ||
    !ts.isPropertyAccessExpression(left) ||
    left.expression.getText(file) !== 'runtime.env' ||
    !ts.isStringLiteral(right)
  ) {
    return undefined;
  }
  return { operator, variable: left.name.text, fallback: right.text };
}
