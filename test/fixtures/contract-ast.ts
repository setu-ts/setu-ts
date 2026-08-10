/** AST-based exact contract comparison for documented TypeScript interfaces. @module */

interface DocNode {
  readonly name: string;
  readonly declarations: readonly DocDeclaration[];
}

interface DocDeclaration {
  readonly kind: string;
  readonly def?: {
    readonly methods?: readonly DocMethod[];
    readonly properties?: readonly DocProperty[];
  };
}

interface DocMethod {
  readonly name: string;
  readonly optional?: boolean;
  readonly params: readonly DocParameter[];
  readonly returnType: DocType;
  readonly typeParams?: readonly {
    readonly name: string;
    readonly default?: { readonly repr: string };
  }[];
}

interface DocParameter {
  readonly name: string;
  readonly optional?: boolean;
  readonly tsType?: DocType;
}

interface DocProperty {
  readonly name: string;
  readonly readonly?: boolean;
  readonly optional?: boolean;
  readonly tsType: DocType;
}

interface DocType {
  readonly repr?: string;
  readonly kind?: string;
  readonly value?: string | readonly DocType[] | {
    readonly typeParams?: readonly DocType[];
    readonly params?: readonly DocParameter[];
    readonly tsType?: DocType;
    readonly operator?: string;
  };
}

interface DocTypeValue {
  readonly typeParams?: readonly DocType[];
  readonly params?: readonly DocParameter[];
  readonly tsType?: DocType;
  readonly operator?: string;
}

interface DocJson {
  readonly nodes: Readonly<
    Record<string, { readonly symbols: readonly DocNode[] }>
  >;
}

export interface ContractMember {
  readonly kind: 'method' | 'property';
  readonly name: string;
  readonly readonly: boolean;
  readonly optional: boolean;
  readonly signature: string;
}

export interface ContractAst {
  readonly members: readonly ContractMember[];
}

function normalizeType(type: DocType): string {
  if (type.kind === 'union' && Array.isArray(type.value)) {
    return type.value.map(normalizeType).join('|');
  }
  const value: DocTypeValue | undefined = typeof type.value === 'object' &&
      !Array.isArray(type.value)
    ? type.value as DocTypeValue
    : undefined;
  if (type.kind === 'array' && value?.tsType !== undefined) {
    return `${normalizeType(value.tsType)}[]`;
  }
  if (type.kind === 'typeOperator' && value?.tsType !== undefined) {
    return `${value.operator ?? ''} ${normalizeType(value.tsType)}`.trim();
  }
  if (type.kind === 'fnOrConstructor' && value?.tsType !== undefined) {
    const params = value.params?.map((parameter) =>
      `${parameter.name}${parameter.optional === true ? '?' : ''}:` +
      (parameter.tsType === undefined ? 'unknown' : normalizeType(parameter.tsType))
    ).join(',') ?? '';
    return `(${params})=>${normalizeType(value.tsType)}`;
  }
  if (type.repr === undefined) {
    throw new Error('AST type has no representation');
  }
  const base = type.repr.replace(/\s+/g, ' ').trim();
  const params = value?.typeParams;
  return params === undefined ? base : `${base}<${params.map(normalizeType).join(',')}>`;
}

function astFromJson(json: string, interfaceName: string): ContractAst {
  const parsed = JSON.parse(json) as DocJson;
  const symbols = Object.values(parsed.nodes).flatMap((node) => node.symbols);
  const matches = symbols.filter((symbol) => symbol.name === interfaceName);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one interface ${interfaceName}, found ${matches.length}`,
    );
  }
  const declarations =
    matches[0]?.declarations.filter((declaration) => declaration.kind === 'interface') ?? [];
  if (declarations.length !== 1 || declarations[0]?.def === undefined) {
    throw new Error(
      `Expected exactly one interface declaration for ${interfaceName}`,
    );
  }
  const def = declarations[0].def;
  const members: ContractMember[] = [];
  for (const method of def.methods ?? []) {
    const typeParams = method.typeParams?.map((parameter) =>
      parameter.default === undefined
        ? parameter.name
        : `${parameter.name}=${parameter.default.repr.replace(/\s+/g, ' ').trim()}`
    ).join(',') ?? '';
    const params = method.params.map((parameter) =>
      `${parameter.name}${parameter.optional === true ? '?' : ''}:` +
      (parameter.tsType === undefined ? 'unknown' : normalizeType(parameter.tsType))
    ).join(',');
    members.push({
      kind: 'method',
      name: method.name,
      readonly: false,
      optional: method.optional === true,
      signature: `${method.name}${method.optional === true ? '?' : ''}` +
        `${typeParams === '' ? '' : `<${typeParams}>`}(${params}):` +
        normalizeType(method.returnType),
    });
  }
  for (const property of def.properties ?? []) {
    members.push({
      kind: 'property',
      name: property.name,
      readonly: property.readonly === true,
      optional: property.optional === true,
      signature: `${property.readonly === true ? 'readonly ' : ''}${property.name}` +
        `${property.optional === true ? '?' : ''}:${normalizeType(property.tsType)}`,
    });
  }
  members.sort((left, right) =>
    left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind)
  );
  const keys = members.map((member) => `${member.kind}:${member.name}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error(`Duplicate member in ${interfaceName}`);
  }
  return { members };
}

/** Parse an interface through Deno's TypeScript AST-backed documentation command. */
export async function contractAst(
  source: string,
  interfaceName: string,
  scratchName: string,
): Promise<ContractAst> {
  await Deno.mkdir('.tmp/contract-ast', { recursive: true });
  const path = `.tmp/contract-ast/${scratchName}.ts`;
  await Deno.writeTextFile(path, source);
  const output = await new Deno.Command('deno', {
    args: ['doc', '--json', path],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
  return astFromJson(new TextDecoder().decode(output.stdout), interfaceName);
}

/** Compare contracts without depending on source member order or formatting. */
export async function contractsMatch(
  source: string,
  documented: string,
  interfaceName: string,
  scratchName: string,
): Promise<boolean> {
  try {
    const actualSource = source.replace(/^import[^;]+;\s*$/gm, '');
    const actual = await contractAst(
      actualSource,
      interfaceName,
      `${scratchName}-actual`,
    );
    const guide = await contractAst(
      documented,
      interfaceName,
      `${scratchName}-guide`,
    );
    return JSON.stringify(guide) === JSON.stringify(actual);
  } catch {
    return false;
  }
}
