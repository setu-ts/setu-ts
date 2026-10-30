/** Examples that can run outside the repository on Node. */
export const EXAMPLES = [
  'minimal',
  'rest-api',
  'database',
  'di-decorators',
  'cqrs',
  'multi-tenant',
  'static-site',
  'worker-pool',
  'graphql-demo',
  'grpc',
  'microservices',
  'realtime',
] as const;

/** One offered example directory. */
export type ExampleName = (typeof EXAMPLES)[number];

/** Repository-dependent examples and the supported way to start instead. */
export const EXCLUDED_EXAMPLES: Readonly<Record<string, string>> = {
  'full-stack': 'uses repository scripts and package source; use --template full-stack',
  'compiled-binary':
    'uses repository build scripts; use --template rest or run it in the repository',
  cloudflare:
    'uses repository smoke/build scripts; use --runtime cloudflare-workers or run it in the repository',
  'realtime-clients':
    'imports repository SDK source and scripts; use --template rest or run it in the repository',
  'plugin-development':
    'uses the repository test configuration; use --template rest or run it in the repository',
};

/** Selects the nearest built-in template for download-failure guidance. */
export function exampleTemplate(example: ExampleName): string {
  return example === 'microservices' ? 'microservice' : 'rest';
}
