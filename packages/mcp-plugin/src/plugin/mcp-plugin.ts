/** Stateless MCP endpoint registered inside the kernel pipeline. @module */
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import type { HandlerResult, IPlugin, IPluginContext, IRequestContext } from '@setu-ts/common';
import { respondWithError } from '@setu-ts/common';
import type { McpPluginOptions } from '../options.ts';
import { resolveOptions } from '../options.ts';
import { McpPluginConfigurationError } from '../errors.ts';
import { compileTools } from '../compile/compile-tools.ts';
import { discoverTools } from '../compile/discovery.ts';
import type { CompiledTool } from '../compile/compile-tools.ts';
import { innerRequest } from '../call/inner-request.ts';
import { originAllowed } from '../serve/origin.ts';
import { accessGate } from '../serve/visibility.ts';
import { CALL_CONTEXT, createServerFactory } from '../sdk/server-factory.ts';
import { VERSION } from '../version.ts';

/** Obtains a terminal marker after a common responder (whose contract returns void). */
function completedResponse(ctx: IRequestContext): HandlerResult {
  const snapshot = ctx.response.snapshot();
  if (snapshot.streaming) return ctx.response.stream(snapshot.body);
  const body =
    typeof snapshot.body === 'string' ? new TextEncoder().encode(snapshot.body) : snapshot.body;
  return ctx.response.send(body ?? undefined);
}

/**
 * Exposes explicitly declared routes as tools, with each call re-entering the pipeline.
 * @param options - Tools, endpoint and transport settings
 * @returns The MCP plugin, named `mcp`
 * @throws {McpPluginConfigurationError} If options are malformed; bootstrap also refuses unusable routes
 * @example
 * ```typescript
 * McpPlugin({ tools: [{ name: 'read', description: 'Read an item', route: { method: 'GET', path: '/items/:id' } }] });
 * ```
 * @since 0.13.0
 */
export function McpPlugin(options: McpPluginOptions): IPlugin {
  const resolved = resolveOptions(options);
  return {
    name: 'mcp',
    version: VERSION,
    register(ctx: IPluginContext): void {
      let tools: readonly CompiledTool[] = [];
      let handler: McpHttpHandler;
      ctx.lifecycle.onBootstrap(async () => {
        if (ctx.app.dispatch === undefined)
          throw new McpPluginConfigurationError('MCP requires IApplication.dispatch.');
        const routes = ctx.router.listRoutes();
        tools = compileTools(discoverTools(routes, resolved), routes);
        handler = await createServerFactory(ctx, tools, resolved, {
          innerRequest: (tool, args, call, signal) =>
            innerRequest(tool, args, call, signal, ctx.runtime),
        });
      });
      ctx.lifecycle.onShutdown(async () => {
        await handler?.close();
      });
      const methodNotAllowed = (request: IRequestContext) =>
        request.response.status(405).header('Allow', 'POST').send();
      ctx.router.get(resolved.path, methodNotAllowed);
      ctx.router.delete(resolved.path, methodNotAllowed);
      ctx.router.post(resolved.path, async (request) => {
        if (!originAllowed(request.request.headers.get('origin'), resolved.allowedOrigins)) {
          respondWithError(request, { status: 403, title: 'Forbidden' });
          return completedResponse(request);
        }
        const text = await request.request.text();
        let parsedBody: unknown;
        let parsed = false;
        try {
          parsedBody = JSON.parse(text);
          parsed = true;
        } catch {
          /* The SDK owns JSON-RPC parse errors. */
        }
        if (parsed && accessGate(parsedBody, tools, request)) return completedResponse(request);
        const raw = new Request(request.request.url, {
          method: 'POST',
          headers: request.request.headers,
          signal: request.signal,
          ...(parsed ? {} : { body: text }),
        });
        CALL_CONTEXT.set(raw, { outer: request });
        try {
          const response = await handler.fetch(raw, parsed ? { parsedBody } : {});
          request.response.status(response.status);
          for (const [name, value] of response.headers) request.response.header(name, value);
          if (response.body === null) return request.response.send();
          return request.response.stream(response.body);
        } finally {
          CALL_CONTEXT.delete(raw);
        }
      });
    },
  };
}
