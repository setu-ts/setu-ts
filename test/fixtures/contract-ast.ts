/** AST-based exact contract comparison for documented TypeScript interfaces. @module */

import ts from 'typescript';

/** One canonical interface member. */
export interface ContractMember {
  readonly kind: 'method' | 'property';
  readonly name: string;
  readonly readonly: boolean;
  readonly optional: boolean;
  readonly signature: string;
}

/** Order-independent interface shape. */
export interface ContractAst {
  readonly members: readonly ContractMember[];
}

/** Parses syntax without resolving types or executing the input. */
export function contractAst(
  source: string,
  interfaceName: string,
  scratchName: string,
): Promise<ContractAst> {
  const file = ts.createSourceFile(scratchName + '.ts', source, ts.ScriptTarget.Latest, true);
  const diagnostics =
    ts.transpileModule(source, {
      fileName: scratchName + '.ts',
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ESNext },
    }).diagnostics ?? [];
  if (diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error))
    throw new Error('Malformed contract syntax');
  const matches: ts.InterfaceDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (matches.length !== 1)
    throw new Error(`Expected exactly one interface ${interfaceName}, found ${matches.length}`);
  const printer = ts.createPrinter({ removeComments: true });
  const text = (node: ts.Node): string =>
    printer.printNode(ts.EmitHint.Unspecified, node, file).replace(/\s+/g, ' ').trim();
  const type = (node: ts.TypeNode | undefined): string => {
    if (!node) return 'unknown';
    if (ts.isUnionTypeNode(node)) return node.types.map(type).join('|');
    if (ts.isArrayTypeNode(node)) return type(node.elementType) + '[]';
    if (ts.isTypeOperatorNode(node)) return ts.tokenToString(node.operator) + ' ' + type(node.type);
    if (ts.isFunctionTypeNode(node))
      return '(' + node.parameters.map(parameter).join(',') + ')=>' + type(node.type);
    if (ts.isTypeReferenceNode(node))
      return (
        text(node.typeName) +
        (node.typeArguments ? '<' + node.typeArguments.map(type).join(',') + '>' : '')
      );
    return text(node);
  };
  const parameter = (node: ts.ParameterDeclaration): string =>
    text(node.name) + (node.questionToken ? '?' : '') + ':' + type(node.type);
  const members: ContractMember[] = [];
  for (const node of matches[0]!.members) {
    if (!ts.isMethodSignature(node) && !ts.isPropertySignature(node))
      throw new Error('Unsupported interface member');
    const name = text(node.name);
    const optional = node.questionToken !== undefined;
    const readonly = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
    if (ts.isMethodSignature(node)) {
      const params =
        node.typeParameters
          ?.map((p) => p.name.text + (p.default ? '=' + type(p.default) : ''))
          .join(',') ?? '';
      members.push({
        kind: 'method',
        name,
        readonly: false,
        optional,
        signature:
          name +
          (optional ? '?' : '') +
          (params ? '<' + params + '>' : '') +
          '(' +
          node.parameters.map(parameter).join(',') +
          '):' +
          type(node.type),
      });
    } else {
      members.push({
        kind: 'property',
        name,
        readonly,
        optional,
        signature:
          (readonly ? 'readonly ' : '') + name + (optional ? '?' : '') + ':' + type(node.type),
      });
    }
  }
  members.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
  if (new Set(members.map((m) => m.kind + ':' + m.name)).size !== members.length)
    throw new Error('Duplicate member in ' + interfaceName);
  return Promise.resolve({ members });
}

/** Compares contracts, refusing malformed or ambiguous inputs. */
export async function contractsMatch(
  source: string,
  documented: string,
  interfaceName: string,
  scratchName: string,
): Promise<boolean> {
  try {
    const actualSource = source.replace(/^import[^;]+;\s*$/gm, '');
    return (
      JSON.stringify(await contractAst(actualSource, interfaceName, scratchName + '-actual')) ===
      JSON.stringify(await contractAst(documented, interfaceName, scratchName + '-guide'))
    );
  } catch {
    return false;
  }
}
