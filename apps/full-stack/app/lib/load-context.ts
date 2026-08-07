import type { RouterContextKey } from '@setu-ts/react-router-plugin';

/**
 * The part of React Router's request context this application reads.
 *
 * Declared structurally so a route can type its loader without importing
 * `react-router`, and so a test can call a server module with a plain object.
 *
 * This module is safe for client code: its only import is a TYPE, which is
 * erased at build time. The keys themselves live in `context-keys.server.ts`,
 * which is server-only.
 */
export interface AppLoadContext {
  /** Reads a context value by key. */
  get<T>(key: RouterContextKey<T>): T;
}
