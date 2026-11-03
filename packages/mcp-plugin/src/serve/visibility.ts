/** Caller visibility and the pre-SDK authorization gate. @module */
import type { IPrincipal, IRequestContext } from '@setu-ts/common';
import { REQUIRED_SCOPES_STATE_KEY, respondWithAuthorizationFailure } from '@setu-ts/common';
import type { CompiledTool } from '../compile/compile-tools.ts';
import { isRecord } from '../options.ts';

/** Whether the caller may see this tool; role and policy checks remain on the route. */
export function isVisible(tool: CompiledTool, principal: IPrincipal | undefined): boolean {
  // A non-array `scopes` (a mapper that copied the raw claim string) holds none:
  // `includes` on a string would match a substring, as auth-plugin's
  // requireScopes also refuses (M132 F-2).
  const held = Array.isArray(principal?.scopes) ? principal.scopes : [];
  return (
    !(tool.authenticated && principal === undefined) &&
    tool.requiredScopes.every((scope) => held.includes(scope))
  );
}

/** Answers hidden single calls at HTTP level; unknown names and batches go to the SDK. */
export function accessGate(
  body: unknown,
  tools: readonly CompiledTool[],
  ctx: IRequestContext,
): boolean {
  if (
    !isRecord(body) ||
    body.method !== 'tools/call' ||
    !isRecord(body.params) ||
    typeof body.params.name !== 'string'
  )
    return false;
  const name = body.params.name;
  const tool = tools.find((entry) => entry.declaration.name === name);
  if (tool === undefined || isVisible(tool, ctx.request.user)) return false;
  if (ctx.request.user === undefined)
    respondWithAuthorizationFailure(ctx, 'authentication-required');
  else {
    ctx.state.set(REQUIRED_SCOPES_STATE_KEY, tool.requiredScopes);
    respondWithAuthorizationFailure(ctx, 'insufficient-privileges');
  }
  return true;
}
