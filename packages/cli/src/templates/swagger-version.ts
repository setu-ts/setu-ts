/**
 * The `swagger-ui-dist` version every generated project installs (M119c, V10-36).
 *
 * `OpenApiPlugin` serves Swagger UI with Subresource Integrity hashes computed
 * for ONE release, and its `{ baseUrl }` asset mode applies those hashes to the
 * application's own installed copy. A range (`^5`) let a fresh install resolve a
 * newer release, whose files no longer match the hashes, and the docs page
 * rendered blank. The exact version keeps the installed copy, the hashes and the
 * plugin's CDN URL in step; a test reads the plugin's rendered CDN URL to keep
 * this value from drifting.
 *
 * Its own module, importing nothing, so every template can read it without the
 * cycle a constant beside the template registry would create.
 *
 * @module
 * @internal
 */

/** The exact `swagger-ui-dist` release the OpenAPI plugin's SRI hashes match. */
export const SWAGGER_UI_DIST_VERSION = '5.33.3';
