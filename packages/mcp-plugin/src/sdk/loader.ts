/** Guarded optional SDK import. @module */
import { OptionalDependencyUnavailableError } from '@setu-ts/common';

/** SDK surface retained behind the lazy import boundary. */
export type Sdk = Pick<
  typeof import('@modelcontextprotocol/server'),
  'McpServer' | 'createMcpHandler'
>;

/** Loads the real SDK only at bootstrap; the internal factory accepts a loadSdk seam. */
export async function loadSdk(): Promise<Sdk> {
  let mod: typeof import('@modelcontextprotocol/server');
  try {
    mod = await import('@modelcontextprotocol/server');
  } catch (cause) {
    throw new OptionalDependencyUnavailableError('@modelcontextprotocol/server', {
      requiredBy: '@setu-ts/mcp-plugin',
      cause,
    });
  }
  return mod;
}
