/**
 * Cross-package `ctx.state` keys, and the convention every key in the
 * framework follows.
 *
 * **The convention:** `<owner-package>:<kebab-key>` — the name of the package
 * that WRITES the key (without the `@setu-ts/` scope), a single colon, and a
 * kebab-case key. Exactly one colon; both halves lowercase. It is
 * self-attributing (a reader of an unfamiliar key can find the package that
 * put it there) and mechanically checkable, which is what lets
 * `test/state-key-convention.test.ts` refuse a new key that does not follow
 * it.
 *
 * **Every key goes through a constant, never a string literal** — the same
 * rule as capability tokens (AI_GUIDELINES §11.2). A key shared by two
 * packages lives HERE, because no plugin may import another (§2.2) and
 * `common` is the only module both sides can read; a key one package both
 * writes and reads stays in that package.
 *
 * | Key                 | Owner                  | Value                                 |
 * | ------------------- | ---------------------- | ------------------------------------- |
 * | client IP           | `http-security-plugin` | `http-security-plugin:client-ip`      |
 * | error responder     | `exceptions`           | `exceptions:error-responder`          |
 * | validated value     | `validation-plugin`    | `validation-plugin:validated-<target>` |
 * | telemetry span      | `telemetry-plugin`     | `telemetry-plugin:span`               |
 * | session             | `session-plugin`       | `session-plugin:session`              |
 * | tenant binding on   | `session-plugin`       | `session-plugin:tenant-binding`       |
 * | uploads             | `storage-plugin`       | `storage-plugin:uploads`              |
 * | tenant cache prefix | `multi-tenancy-plugin` | `multi-tenancy-plugin:cache-prefix`   |
 *
 * @module
 */

/**
 * The `ctx.state` key under which `http-security-plugin`'s
 * `ipSecurityMiddleware` publishes the resolved client IP, and from which
 * `auth-plugin`'s `rateLimitMiddleware` reads it back.
 *
 * Exported from `common` so the two packages agree on the value byte-for-byte
 * instead of each hardcoding the literal — the `validatedStateKey` precedent.
 * Before this constant existed both sides spelled `'clientIp'` inline, where a
 * typo on one side is a silent miss rather than a compile error.
 *
 * @example
 * ```typescript
 * const ip = ctx.state.get(CLIENT_IP_STATE_KEY) as string | undefined;
 * ```
 * @since 0.1.0
 */
export const CLIENT_IP_STATE_KEY = 'http-security-plugin:client-ip';

/**
 * The `ctx.state` key under which `session-plugin`'s middleware parks the
 * live {@linkcode ISession} for the request, and from which
 * `multi-tenancy-plugin`'s tenant middleware reads it back for the
 * tenant-binding compare that runs on whichever side sees the tenant second
 * (M101c, V8-7).
 *
 * Exported from `common` so the two packages agree on the value byte-for-byte
 * instead of each hardcoding the literal — the `validatedStateKey` precedent.
 *
 * @example
 * ```typescript
 * const session = ctx.state.get(SESSION_STATE_KEY) as ISession | undefined;
 * ```
 * @since 0.9.0
 */
export const SESSION_STATE_KEY = 'session-plugin:session';

/**
 * The `ctx.state` key under which `session-plugin`'s middleware publishes
 * whether tenant binding is ON for this request (`true`) — set beside
 * {@linkcode SESSION_STATE_KEY} only when `SessionPlugin({ tenantBinding })`
 * is enabled, which is the default.
 *
 * `multi-tenancy-plugin`'s tenant-side compare reads it and compares only when
 * it is `true`, so `tenantBinding: false` means "no compare" on BOTH compare
 * sites and in every middleware order (M101c, V8-7). Without it the tenant side
 * could not see the session plugin's option, and a session sealed before the
 * option was turned off would still be refused when the tenant is resolved
 * after the session loads — while the same request passed at the default
 * resolver priority.
 *
 * @example
 * ```typescript
 * const bindingOn = ctx.state.get(SESSION_TENANT_BINDING_STATE_KEY) === true;
 * ```
 * @since 0.9.0
 */
export const SESSION_TENANT_BINDING_STATE_KEY = 'session-plugin:tenant-binding';
