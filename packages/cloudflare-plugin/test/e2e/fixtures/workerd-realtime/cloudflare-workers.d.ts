/**
 * The slice of the `cloudflare:workers` module the fixture Workers import.
 * The module exists only inside workerd; this lets the repository's type check
 * read the fixtures.
 */
declare module 'cloudflare:workers' {
  export const env: Record<string, unknown>;
  export function waitUntil(promise: Promise<unknown>): void;
  export class DurableObject {
    protected readonly ctx: {
      acceptWebSocket(socket: unknown): void;
      getWebSockets(): unknown[];
    };
    constructor(ctx: unknown, env: unknown);
  }
}
