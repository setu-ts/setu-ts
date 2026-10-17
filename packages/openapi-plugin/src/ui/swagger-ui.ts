/**
 * Swagger UI HTML generator.
 *
 * Serves self-hosted assets by default, or pinned external assets with SRI.
 *
 * @module
 */

/**
 * Swagger UI asset delivery. Self-hosting requires swagger-ui-dist and runtime.fs;
 * CDN and baseUrl modes serve the pinned 5.33.3 files with integrity checks.
 * @since 0.10.0
 */
export type SwaggerOptions = {
  /** Defaults to 'self'. A custom base must serve the pinned, unmodified files. */
  readonly assets?: 'self' | 'cdn' | { readonly baseUrl: string };
};

/** Fixed asset inventory; no request path is ever used as a filesystem path. */
export const SWAGGER_ASSETS = [
  {
    file: 'swagger-ui.css',
    contentType: 'text/css; charset=utf-8',
    integrity: 'sha384-Ov4/wv3j2bmct8cDc5X4ngJZohVPzEmc6uDPH8WeljUxO5vtoykvMEfbu9Vh6RaW',
  },
  {
    file: 'swagger-ui-bundle.js',
    contentType: 'application/javascript; charset=utf-8',
    integrity: 'sha384-h00llMzD1afyNow1pDmnZKlHsUZgp9KE9HXLFXF2CvbwsBY0+WBO4f75SfGwvM4K',
  },
  {
    file: 'swagger-ui-standalone-preset.js',
    contentType: 'application/javascript; charset=utf-8',
    integrity: 'sha384-My2aDM4r2Mbm3ybHcubKm9O9U8FEjvF/O5nGvE9YK5dzqOTbWEKa79RPJ1krdMaF',
  },
] as const;

/** Resolves and validates delivery options at plugin construction. @internal */
export function resolveSwaggerAssets(
  swagger: boolean | SwaggerOptions,
): NonNullable<SwaggerOptions['assets']> {
  if (
    typeof swagger !== 'boolean' &&
    (typeof swagger !== 'object' || swagger === null || Array.isArray(swagger))
  ) {
    throw new TypeError('OpenApiPlugin swagger must be a boolean or options object.');
  }
  const assets =
    typeof swagger === 'boolean' || swagger.assets === undefined ? 'self' : swagger.assets;
  if (assets === 'self' || assets === 'cdn') return assets;
  if (typeof assets === 'object' && assets !== null && typeof assets.baseUrl === 'string') {
    const base = assets.baseUrl;
    const trimmed = base.replace(/\/+$/, '');
    // Printable ASCII without a backslash, `?` or `#`: a browser resolves
    // `/\host` to another host, `new URL()` silently trims whitespace that the
    // emitted attribute would still carry, and the file names are appended to
    // the base, so a query or fragment would swallow them.
    if (/^[\x21-\x22\x24-\x3e\x40-\x5b\x5d-\x7e]+$/.test(base)) {
      if (/^\/(?!\/)/.test(base)) return { baseUrl: trimmed };
      try {
        const url = new URL(base);
        // Only a base that is already its own serialization: what the
        // validator saw is exactly what the browser will request.
        // Credentials are refused: the base is written into a public page.
        if (
          (url.protocol === 'https:' || url.protocol === 'http:') &&
          url.username === '' &&
          url.password === '' &&
          url.href.replace(/\/+$/, '') === trimmed
        )
          return { baseUrl: trimmed };
      } catch {
        // Report the fixed configuration error below without echoing input.
      }
    }
  }
  throw new TypeError(
    'OpenApiPlugin swagger.assets must be self, cdn, or { baseUrl } with an absolute HTTP(S) URL or / path, without credentials, query or fragment.',
  );
}

/**
 * Options for Swagger UI HTML generation.
 *
 * @since 0.1.0
 */
export interface SwaggerUiOptions {
  /** Asset delivery mode, defaulting to self-hosting. @since 0.10.0 */
  readonly assets?: SwaggerOptions['assets'];
  /** Self-hosted route prefix. Defaults to '/docs'. @since 0.10.0 */
  readonly endpoint?: string;
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
    __CSS_ASSET__
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
  <script __BUNDLE_ASSET__></script>
  <script __PRESET_ASSET__></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: "__SPEC_URL__",
        dom_id: "#swagger-ui",
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset,
        ],
        layout: "StandaloneLayout",
      });
    };
  </script>
</body>
</html>
`;

const AMP_ENTITY = '&amp;';
const LT_ENTITY = '&lt;';
const GT_ENTITY = '&gt;';
const QUOT_ENTITY = '&quot;';
const APOS_ENTITY = '&apos;';

/**
 * HTML-escapes a string for safe embedding in HTML.
 *
 * @param str - The string to escape
 * @returns The escaped string
 */
function htmlEscape(str: string): string {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === '&') {
      result += AMP_ENTITY;
    } else if (char === '<') {
      result += LT_ENTITY;
    } else if (char === '>') {
      result += GT_ENTITY;
    } else if (char === '"') {
      result += QUOT_ENTITY;
    } else if (char === '\x27') {
      result += APOS_ENTITY;
    } else {
      result += char;
    }
  }
  return result;
}

/**
 * Generates the Swagger UI HTML page.
 *
 * @param options - Options for the UI
 * @returns The complete HTML document
 * @throws {TypeError} If the asset mode or custom base URL is invalid
 * @since 0.1.0
 */
export function swaggerUiHtml(options: SwaggerUiOptions | string): string {
  const assets = resolveSwaggerAssets(
    typeof options === 'string'
      ? true
      : { ...(options.assets === undefined ? {} : { assets: options.assets }) },
  );
  const endpoint = typeof options === 'string' ? '/docs' : (options.endpoint ?? '/docs');
  const baseUrl =
    assets === 'self'
      ? endpoint.replace(/\/+$/, '')
      : assets === 'cdn'
        ? 'https://unpkg.com/swagger-ui-dist@5.33.3'
        : assets.baseUrl;
  const attributes = SWAGGER_ASSETS.map(
    (asset, i) =>
      `${i === 0 ? 'href' : 'src'}="${htmlEscape(`${baseUrl}/${asset.file}`)}"` +
      (assets === 'self' ? '' : ` integrity="${asset.integrity}" crossorigin="anonymous"`),
  );
  const specUrl = typeof options === 'string' ? options : options.specUrl;
  const title =
    typeof options === 'string' ? 'API Documentation' : (options.title ?? 'API Documentation');

  // Escape both title and specUrl to prevent XSS via malicious input
  const escapedTitle = htmlEscape(title);
  const escapedSpecUrl = htmlEscape(specUrl);

  // Use function replacement for title to avoid JS $-pattern interpretation in replacement strings
  // (e.g., $&, $1, $2 would otherwise be treated as backreferences)
  return HTML_TEMPLATE.replace(/<title>.*?<\/title>/, () => `<title>${escapedTitle}</title>`)
    .replace(/__SPEC_URL__/g, () => escapedSpecUrl)
    .replace('__CSS_ASSET__', () => attributes[0]!)
    .replace('__BUNDLE_ASSET__', () => attributes[1]!)
    .replace('__PRESET_ASSET__', () => attributes[2]!);
}
