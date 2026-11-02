/** Compiles immutable route bindings once after registration. @module */
import {
  idempotencyMetadataOf,
  responseMetadataOf,
  securityMetadataOf,
  validationMetadataOf,
} from '@setu-ts/common';
import type { RouteInfo } from '@setu-ts/common';
import { McpPluginConfigurationError } from '../errors.ts';
import type { McpToolDeclaration } from '../options.ts';
import { isRecord } from '../options.ts';
import { mergeInput, toJsonSchema } from './json-schema.ts';
import type { InputSchema, JsonSchema } from './json-schema.ts';

/** Everything needed by a request; no route metadata is read at call time. */
export interface CompiledTool extends InputSchema {
  readonly declaration: McpToolDeclaration;
  readonly outputSchema?: JsonSchema;
  readonly outputValidator?: { safeParse(value: unknown): { readonly success: boolean } };
  readonly idempotent: boolean;
  readonly annotations: { readonly readOnlyHint: boolean; readonly idempotentHint: boolean };
  readonly authenticated: boolean;
  readonly requiredScopes: readonly string[];
}

/** Recursively freezes JSON schema data without freezing application-owned Zod schemas. */
function freezeSchema(schema: JsonSchema): JsonSchema {
  const copy = JSON.parse(JSON.stringify(schema)) as JsonSchema;
  const freeze = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(copy);
  return copy;
}

/** Binds declarations to exact registered patterns and derives their security and schemas. */
export function compileTools(
  declarations: readonly McpToolDeclaration[],
  routes: readonly RouteInfo[],
): readonly CompiledTool[] {
  return Object.freeze(
    declarations.map((declaration) => {
      const route = routes.find(
        (entry) =>
          entry.method === declaration.route.method && entry.path === declaration.route.path,
      );
      if (route === undefined)
        throw new McpPluginConfigurationError(`MCP route not registered: ${declaration.name}`);
      const brands = new Map<string, unknown>();
      let idempotent = false;
      let authenticated = false;
      const scopes = new Set<string>();
      for (const middleware of route.definition.middleware ?? []) {
        const validation = validationMetadataOf(middleware);
        if (validation !== undefined) brands.set(validation.target, validation.schema);
        idempotent ||= idempotencyMetadataOf(middleware) !== undefined;
        const security = securityMetadataOf(middleware);
        authenticated ||= security?.authenticated === true;
        for (const scope of security?.scopes ?? []) scopes.add(scope);
      }
      const method = declaration.route.method;
      if (idempotent && !authenticated)
        throw new McpPluginConfigurationError(
          `MCP idempotency requires an authenticating security brand: ${route.method} ${route.path}`,
        );
      if (['POST', 'PUT', 'PATCH'].includes(method) && !brands.has('body'))
        throw new McpPluginConfigurationError(`MCP body validation required: ${declaration.name}`);
      if (['POST', 'PATCH'].includes(method) && !idempotent && declaration.repeatable !== true)
        throw new McpPluginConfigurationError(`MCP retry safety required: ${declaration.name}`);
      const input = mergeInput(route.path, brands);
      const status = responseMetadataOf(route.definition.handler)?.status ?? 200;
      const response = route.definition.schema?.response?.[status];
      const output = isRecord(response) && 'schema' in response ? response.schema : response;
      let outputSchema: JsonSchema | undefined;
      if (
        isRecord(output) &&
        typeof output.toJSONSchema === 'function' &&
        typeof output.safeParse === 'function'
      ) {
        try {
          const converted = toJsonSchema(output, 'output');
          if (converted.type === 'object') outputSchema = freezeSchema(converted);
        } catch {
          // Only representable Zod object schemas supply outputSchema (§3.2).
          outputSchema = undefined;
        }
      }
      return Object.freeze({
        ...input,
        schema: freezeSchema(input.schema),
        declaration,
        idempotent,
        authenticated,
        requiredScopes: Object.freeze([...scopes].sort()),
        annotations: Object.freeze({
          readOnlyHint: method === 'GET',
          idempotentHint:
            ['GET', 'PUT', 'DELETE'].includes(method) ||
            idempotent ||
            declaration.repeatable === true,
        }),
        ...(outputSchema === undefined
          ? {}
          : {
              outputSchema,
              outputValidator: output as { safeParse(value: unknown): { success: boolean } },
            }),
      });
    }),
  );
}
