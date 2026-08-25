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
