/** Bootstrap-only Zod conversion and flat input merging. @module */
import { McpPluginConfigurationError } from '../errors.ts';
import { isRecord } from '../options.ts';

/** JSON Schema object, kept independent of the SDK. */
export type JsonSchema = Record<string, unknown>;
/** Destination for a top-level argument. */
export type ArgumentSource = 'path' | 'query' | 'body';
/** The schema and split table compiled from route metadata. */
export interface InputSchema {
  readonly schema: JsonSchema;
  readonly sources: Readonly<Record<string, ArgumentSource>>;
  readonly hasBody: boolean;
}

/** Converts only Zod v4's public JSON Schema surface. */
export function toJsonSchema(schema: unknown, io: 'input' | 'output'): JsonSchema {
  if (!isRecord(schema) || typeof schema.toJSONSchema !== 'function')
    throw new McpPluginConfigurationError('MCP requires a Zod v4 toJSONSchema schema.');
  try {
    const result: unknown = schema.toJSONSchema({
      target: 'draft-2020-12',
      io,
      unrepresentable: 'throw',
    });
    if (!isRecord(result)) throw new Error('Invalid JSON Schema');
    return result;
  } catch {
    throw new McpPluginConfigurationError('MCP could not convert the route schema.');
  }
}

/** Refuses roots that cannot be split into a flat argument object. */
function objectProperties(schema: JsonSchema): Record<string, unknown> {
  if (schema.type !== 'object' || !isRecord(schema.properties))
    throw new McpPluginConfigurationError('MCP input schema must be an object with properties.');
  return schema.properties;
}

/** Query values have one URLSearchParams representation: scalar or scalar array. */
function scalar(schema: unknown): boolean {
  return (
    isRecord(schema) &&
    ['string', 'number', 'integer', 'boolean', 'null'].includes(String(schema.type))
  );
}

/** Merges path, query and body properties, refusing ambiguous destinations. */
export function mergeInput(path: string, brands: ReadonlyMap<string, unknown>): InputSchema {
  const properties: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const sources: Record<string, ArgumentSource> = Object.create(null) as Record<
    string,
    ArgumentSource
  >;
  const required = new Set<string>();
  const params = brands.has('params') ? toJsonSchema(brands.get('params'), 'input') : undefined;
  const query = brands.has('query') ? toJsonSchema(brands.get('query'), 'input') : undefined;
  const body = brands.has('body') ? toJsonSchema(brands.get('body'), 'input') : undefined;
  const add = (name: string, schema: unknown, source: ArgumentSource): void => {
    if (Object.hasOwn(sources, name))
      throw new McpPluginConfigurationError(`MCP argument collision: ${name}`);
    properties[name] = schema;
    sources[name] = source;
  };
  const paramProperties = params === undefined ? {} : objectProperties(params);
  for (const match of path.matchAll(/:([A-Za-z0-9_]+)(\?)?/g)) {
    const name = match[1]!;
    add(
      name,
      Object.hasOwn(paramProperties, name) ? paramProperties[name] : { type: 'string' },
      'path',
    );
    // The kernel's final `:name?` matches with or without the segment.
    if (match[2] === undefined) required.add(name);
  }
  for (const [source, schema] of [
    ['query', query],
    ['body', body],
  ] as const) {
    if (schema === undefined) continue;
    for (const [name, property] of Object.entries(objectProperties(schema))) {
      if (
        source === 'query' &&
        !(
          scalar(property) ||
          (isRecord(property) && property.type === 'array' && scalar(property.items))
        )
      )
        throw new McpPluginConfigurationError(`MCP query property must be scalar: ${name}`);
      add(name, property, source);
    }
    if (Array.isArray(schema.required))
      for (const name of schema.required) if (typeof name === 'string') required.add(name);
  }
  if (query?.$defs !== undefined && body?.$defs !== undefined)
    throw new McpPluginConfigurationError('MCP query and body cannot both define $defs.');
  const defs = body?.$defs ?? query?.$defs ?? params?.$defs;
  return {
    schema: {
      type: 'object',
      properties,
      required: [...required],
      // Always closed: an argument with no path, query or body property has no
      // destination in the inner request, so advertising extras would invite a
      // call the dispatcher refuses.
      additionalProperties: false,
      ...(defs === undefined ? {} : { $defs: defs }),
    },
    sources: Object.freeze(sources),
    hasBody: body !== undefined,
  };
}
