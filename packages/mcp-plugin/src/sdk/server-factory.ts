/** One SDK handler, with a fresh caller-filtered server per request. @module */
import type {
  CallToolResult,
  McpHttpHandler,
  StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import type { IPluginContext, IRequestContext, TimerHandle } from '@setu-ts/common';
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
            let abortedResult: CallToolResult | undefined;
            try {
              const controller = new AbortController();
              const clientSignal = sdkCtx.mcpReq.signal;
              const expired = Promise.withResolvers<CallToolResult>();
              const abort = (message: string): void => {
                if (controller.signal.aborted) return;
                abortedResult = toolError(message);
                // Settle the race before a cooperative route responds to abort.
                expired.resolve(abortedResult);
                controller.abort();
              };
              const onClientAbort = (): void => abort('The tool failed.');
              let timer: TimerHandle | undefined;
              try {
                clientSignal.addEventListener('abort', onClientAbort, { once: true });
                if (clientSignal.aborted) onClientAbort();
                if (abortedResult !== undefined) return abortedResult;
                timer = ctx.runtime.setTimeout(
                  () => abort('The tool timed out.'),
                  options.timeoutMs,
                );
                // Race all work, including the body read: cancellation alone cannot
                // bound a route or response stream that ignores its signal.
                return await Promise.race([
                  (async (): Promise<CallToolResult> => {
                    const request = await deps.innerRequest(tool, args, call, controller.signal);
                    controller.signal.throwIfAborted();
                    const ip = call.outer.request.ip;
                    const response = await ctx.app.dispatch!(request, {
                      route: tool.declaration.route.path,
                      ...(ip === undefined ? {} : { ip }),
                    });
                    const result = await mapResult(
                      response,
                      tool,
                      options.maxResultBytes,
                      controller.signal,
                    );
                    controller.signal.throwIfAborted();
                    return result;
                  })(),
                  expired.promise,
                ]);
              } finally {
                try {
                  if (timer !== undefined) ctx.runtime.clearTimeout(timer);
                } finally {
                  clientSignal.removeEventListener('abort', onClientAbort);
                }
              }
            } catch (error) {
              // Cleanup failures are contained too: nothing may throw into the SDK.
              return (
                abortedResult ??
                toolError(
                  error instanceof UnusableArgumentError
                    ? 'The tool received an argument it cannot use.'
                    : 'The tool failed.',
                )
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
