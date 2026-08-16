/**
 * Shared WebSocket upgrade detection.
 *
 * The rule itself lives in `@setu-ts/common` since M70a, because the kernel
 * now decides whether a request is an upgrade — after the middleware pipeline
 * has run — and the kernel does not depend on this package. Re-exporting keeps
 * `isWebSocketUpgradeRequest` a published symbol of `@setu-ts/runtime` while
 * leaving exactly one implementation (AI_GUIDELINES §11.1).
 *
 * @module
 * @since 0.2.0
 */

export { isWebSocketUpgradeRequest } from '@setu-ts/common';
