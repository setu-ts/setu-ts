/**
 * Response-shaping decorators — `@HttpCode`, `@ResponseHeader` and `@Redirect`
 * let a handler state its success status and its response headers in its
 * declaration instead of accepting `@Ctx()` purely to say one fixed thing about
 * the response.
 *
 * `@Ctx()` is not replaced and is not deprecated: it stays the way to compute a
 * status or a header PER REQUEST, and it is the only way to write a
 * multi-valued header. These three are for the fixed, declarative case — which
 * is also the case a documentation generator can read, since
 * `@setu-ts/openapi-plugin` derives an operation's success status from the
 * `RouteResponseMetadata` brand this package puts on the handler.
 *
 * Every argument is a compile-time literal, so every one of them is checked at
 * `register()` rather than per request: see `response-status.ts` for what is
 * refused and why.
 *
 * @module
 * @since 0.7.0
 */
import { methodDecorator } from '../metadata/context-bridge.ts';
import type { SetuMethodDecorator } from '../metadata/context-bridge.ts';

/** The status `@Redirect` uses when none is given, matching `IResponse.redirect`. */
const DEFAULT_REDIRECT_STATUS = 302;

/**
 * Declares the HTTP status a handler answers with when it returns a plain
 * value.
 *
 * Without it a decorated handler is always `200`: the plugin answers
 * `ctx.response.json(result)` for any return that is not already a
 * `HandlerResult`. `@HttpCode(201)` is what lets a `create` handler say `201`
 * without accepting a request context it otherwise has no use for.
 *
 * **A returned `HandlerResult` still wins.** The status is written to the
 * response builder BEFORE the handler runs, so a handler that returns
 * `ctx.response.status(202).json(...)` answers `202` even under
 * `@HttpCode(201)` — the explicit runtime value is the more specific
 * statement. It composes with `@Render` for the same reason: the rendered HTML
 * is written onto a builder that already carries the status.
 *
 * `204`, `205` and `304` serve a bodiless response: the runtime's snapshot
 * mapping drops a body written at one of those statuses, which is the
 * conformant answer RFC 9110 §15.3.5 asks for and exactly what a `DELETE`
 * handler wants.
 *
 * `status` must be an integer in `[200, 599]` — the range the web `Response`
 * constructor accepts. Anything else is refused at `register()`, naming the
 * class, the method and the value, because the alternative is a `RangeError`
 * thrown inside the adapter after the pipeline has finished, where no error
 * handler can answer it.
 *
 * It is deliberately NOT narrowed to `2xx`: a handler answering `404` through a
 * decorator is legitimate, and the exception hierarchy owns the error path
 * without monopolising the status space.
 *
 * @param status - The success status, an integer in `[200, 599]`
 * @returns A standard method decorator
 * @throws {Error} At `register()`, when `status` is not a serveable status, or
 *   when the same handler also carries `@Redirect`
 * @example
 * ```typescript
 * @Controller('/orders')
 * class OrderController {
 *   @HttpCode(201)
 *   @Post('/')
 *   create(@Params(Body()) order: OrderInput): OrderView {
 *     return this.orders.create(order);
 *   }
 * }
 * ```
 * @since 0.7.0
 */
export function HttpCode(status: number): SetuMethodDecorator {
  return methodDecorator((store, target, handler) => {
    store.mutateMethod(target, handler, (meta) => {
      // Replace-scalar, like every other scalar metadata field. Decorators
      // apply BOTTOM-UP, so when a handler carries two the TOPMOST one wins.
      meta.httpCode = status;
    });
  });
}

/**
 * Declares a fixed response header for a handler.
 *
 * Repeatable for DISTINCT names. The same name twice is refused at
 * `register()` — `Headers.set` overwrites, so the second declaration would
 * silently erase the first, and a multi-valued header (`Set-Cookie`, `Vary`)
 * wants `ctx.response.appendHeader(...)` through `@Ctx()` instead. Names are
 * compared case-insensitively, per RFC 9110 §5.1.
 *
 * The name and value are validated at `register()` by the runtime's own rule:
 * an invalid pair throws `TypeError` while the response headers are written,
 * which would answer `500` on every request to the route.
 *
 * **Cost note.** Writing a header materialises the response's `Headers` object,
 * ending the fast path by which the common terminal shapes hand a
 * snapshot-local header init straight to the native `Response` constructor. A
 * bare `@HttpCode` route pays nothing — setting a status is an assignment that
 * touches no header state. This is the correct trade for a route that asked for
 * a header; it is stated here so the cost is visible at the declaration.
 *
 * Deliberately NOT derived into the OpenAPI document: an OpenAPI response
 * header entry needs a schema and a description this declaration does not
 * carry, so deriving one would put an under-specified `headers` object into
 * every document that used the decorator.
 *
 * @param name - The header name
 * @param value - The header value
 * @returns A standard method decorator
 * @throws {Error} At `register()`, when the runtime refuses the pair, when the
 *   same name is declared twice, or when `Location` is declared alongside
 *   `@Redirect`
 * @example
 * ```typescript
 * @Controller('/reports')
 * class ReportController {
 *   @ResponseHeader('Cache-Control', 'no-store')
 *   @ResponseHeader('X-Report-Version', '3')
 *   @Get('/latest')
 *   latest(): ReportView {
 *     return this.reports.latest();
 *   }
 * }
 * ```
 * @since 0.7.0
 */
export function ResponseHeader(name: string, value: string): SetuMethodDecorator {
  return methodDecorator((store, target, handler) => {
    store.mutateMethod(target, handler, (meta) => {
      const headers = meta.responseHeaders ?? [];
      headers.push({ name, value });
      meta.responseHeaders = headers;
    });
  });
}

/**
 * Declares that a handler answers with a redirect: the given status and a
 * `Location` header.
 *
 * **It does not short-circuit the handler.** A decorator cannot decline to call
 * the method — the plugin invokes it before it can inspect anything it returns
 * — so a `@Redirect` that claimed to skip the body would be describing a path
 * it does not control. The handler still runs and a plain return is still
 * serialised. That is the point of the declarative form: the handler's work is
 * the side effect, and the redirect is a property of the route.
 *
 * A handler that wants to decide per request should call
 * `ctx.response.redirect(url)` itself through `@Ctx()`, which terminates the
 * response and returns a `HandlerResult`.
 *
 * `status` must be an integer in `[300, 399]`, refused at `register()`
 * otherwise, and the same handler may not also carry `@HttpCode` — both set the
 * status.
 *
 * @param url - The `Location` header value
 * @param status - The redirect status; `302` by default, matching `IResponse.redirect`
 * @returns A standard method decorator
 * @throws {Error} At `register()`, when `status` is not a redirect status, or
 *   when the same handler also carries `@HttpCode`
 * @example
 * ```typescript
 * @Controller('/docs')
 * class DocsController {
 *   @Redirect('/docs/v2', 301)
 *   @Get('/v1')
 *   legacy(): void {
 *     this.metrics.recordLegacyHit();
 *   }
 * }
 * ```
 * @since 0.7.0
 */
export function Redirect(
  url: string,
  status: number = DEFAULT_REDIRECT_STATUS,
): SetuMethodDecorator {
  return methodDecorator((store, target, handler) => {
    store.mutateMethod(target, handler, (meta) => {
      meta.redirect = { url, status };
    });
  });
}
