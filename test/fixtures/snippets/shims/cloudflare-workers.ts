/**
 * The two `cloudflare:workers` members the guides import, typed as the platform
 * supplies them. The specifier only resolves on a Worker toolchain; `deno check`
 * treated it as untyped, so this is stricter than the gate it replaces. Compile-only.
 * @module
 */
/** The Worker's bindings and variables. */
export declare const env: Readonly<Record<string, unknown>>;
/** Extends the invocation's lifetime until the promise settles. */
export declare function waitUntil(promise: Promise<unknown>): void;
