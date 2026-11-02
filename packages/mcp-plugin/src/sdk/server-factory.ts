/** One SDK handler, with a fresh caller-filtered server per request. @module */
import type {
  CallToolResult,
  McpHttpHandler,
  StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import type { IPluginContext, IRequestContext } from '@setu-ts/common';
import type { CompiledTool } from '../compile/compile-tools.ts';
import type { JsonSchema } from '../compile/json-schema.ts';
import type { ResolvedOptions } from '../options.ts';
import { UnusableArgumentError } from '../errors.ts';
import { mapResult, toolError } from '../call/result-mapping.ts';
import { isVisible } from '../serve/visibility.ts';
import { loadSdk } from './loader.ts';

/** Request context never travels through authInfo or a fabricated credential. */
export interface CallContext {
  readonly outer: IRequestContext;
}
/** Private Request identity is the only key accepted from the SDK factory. */
export const CALL_CONTEXT: WeakMap<Request, CallContext> = new WeakMap<Request, CallContext>();

/** A schema carrier only; route middleware owns input validation. */
export function passThroughSchema(schema: JsonSchema): StandardSchemaWithJSON {
  return {
    '~standard': {
      version: 1,
      vendor: 'setu-ts',
      validate: (value) => ({ value }),
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}

/** Internal seams keep SDK loading and the never-throw executor directly testable. */
export interface FactoryDeps {
  readonly loadSdk?: typeof loadSdk;
  readonly innerRequest: (
    tool: CompiledTool,
    args: unknown,
    call: CallContext,
    signal: AbortSignal,
  ) => Promise<Request>;
}

/** Creates a single SDK handler; schema compilation has already finished. */
export async function createServerFactory(
  ctx: IPluginContext,
  tools: readonly CompiledTool[],
  options: ResolvedOptions,
  deps: FactoryDeps,
): Promise<McpHttpHandler> {
  const sdk = await (deps.loadSdk ?? loadSdk)();
  return sdk.createMcpHandler(
    ({ requestInfo }) => {
      const call = requestInfo === undefined ? undefined : CALL_CONTEXT.get(requestInfo);
      const server = new sdk.McpServer(options.serverInfo, {
        // The tool set is fixed at bootstrap: say so explicitly, because the SDK
        // advertises `listChanged: true` whenever the bit is left unset.
        capabilities: { tools: { listChanged: false } },
        ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
        cacheHints: { 'tools/list': { ttlMs: 0, cacheScope: 'private' } },
      });
      if (call === undefined) return server;
      for (const tool of tools) {
        if (!isVisible(tool, call.outer.request.user)) continue;
        server.registerTool(
          tool.declaration.name,
          {
            description: tool.declaration.description,
            ...(tool.declaration.title === undefined ? {} : { title: tool.declaration.title }),
            inputSchema: passThroughSchema(tool.schema),
            ...(tool.outputSchema === undefined
              ? {}
              : { outputSchema: passThroughSchema(tool.outputSchema) }),
            annotations: tool.annotations,
          },
          async (args, sdkCtx): Promise<CallToolResult> => {
            try {
              const request = await deps.innerRequest(tool, args, call, sdkCtx.mcpReq.signal);
              sdkCtx.mcpReq.signal.throwIfAborted();
              const ip = call.outer.request.ip;
              const response = await ctx.app.dispatch!(request, ip === undefined ? {} : { ip });
              const result = await mapResult(response, tool, options.maxResultBytes);
              sdkCtx.mcpReq.signal.throwIfAborted();
              return result;
            } catch (error) {
              // Only our own argument refusal is shown; thrown messages from dispatch never leave.
              return toolError(
                error instanceof UnusableArgumentError
                  ? 'The tool received an argument it cannot use.'
                  : 'The tool failed.',
              );
            }
          },
        );
      }
      return server;
    },
    { legacy: options.legacy, responseMode: 'json' },
  );
}
