/**
 * GraphiQL UI — serve an interactive GraphQL IDE.
 *
 * @module
 */

/**
 * Escape an HTML string.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&' + 'amp;')
    .replace(/</g, '&' + 'lt;')
    .replace(/>/g, '&' + 'gt;')
    .replace(/"/g, '&' + 'quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Options for producing the GraphiQL page.
 */
export interface GraphiQLOptions {
  endpoint: string;
  title?: string;
}

/**
 * Generate a GraphiQL HTML page.
 *
 * @param options - The options
 * @returns An HTML string
 */
export function graphiqlHtml(options: GraphiQLOptions): string {
  const endpoint = escapeHtml(options.endpoint);
  const title = escapeHtml(options.title ?? 'GraphiQL');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { margin: 0; padding: 0; height: 100vh; overflow: hidden; }
    #root { height: 100vh; }
  </style>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <link rel="stylesheet" href="https://unpkg.com/graphiql/graphiql.min.css" />
</head>
<body>
  <div id="root"></div>
  <script crossorigin src="https://unpkg.com/graphiql/graphiql.min.js"></script>
  <script>
    const fetcher = GraphiQL.createFetcher({ url: '${endpoint}' });
    ReactDOM.createRoot(document.getElementById('root')).render(
      React.createElement(GraphiQL, { fetcher: fetcher })
    );
  </script>
</body>
</html>`;
}
