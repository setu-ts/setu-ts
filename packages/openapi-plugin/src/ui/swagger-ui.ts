/**
 * Swagger UI HTML generator.
 *
 * Serves an HTML page that loads Swagger UI from CDN and points it at the spec endpoint.
 *
 * @module
 */

/**
 * Options for Swagger UI HTML generation.
 *
 * @since 0.1.0
 */
export interface SwaggerUiOptions {
  /** The URL of the OpenAPI spec JSON. */
  readonly specUrl: string;
  /** The title of the page. */
  readonly title?: string;
}

/**
 * Cached HTML template (built once at module load).
 *
 * @since 0.1.0
 */
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>API Documentation</title>
  <link
    rel="stylesheet"
    href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"
  />
  <style>
    body {
      margin: 0;
      padding: 0;
    }
    #swagger-ui {
      max-width: 1460px;
      margin: 0 auto;
    }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: '__SPEC_URL__',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset,
        ],
        layout: 'StandaloneLayout',
      });
    };
  </script>
</body>
</html>
`;

/**
 * Generates the Swagger UI HTML page.
 *
 * @param options - Options for the UI
 * @returns The complete HTML document
 * @since 0.1.0
 */
export function swaggerUiHtml(options: SwaggerUiOptions | string): string {
  const specUrl = typeof options === 'string' ? options : options.specUrl;
  const title = typeof options === 'string'
    ? 'API Documentation'
    : (options.title ?? 'API Documentation');

  return HTML_TEMPLATE
    .replace(/<title>.*?<\/title>/, `<title>${title}</title>`)
    .replace(/__SPEC_URL__/g, specUrl);
}
