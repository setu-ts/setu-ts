/**
 * The `npm:` specifier of every instrumentation loader must be a LITERAL at its
 * own `import()` call, and must agree with the specifier the loader reports.
 *
 * Two properties, one test, because each hides a different defect:
 *
 * 1. **Literal.** JSR's npm-compatibility rewrite is static and reaches only a
 *    literal `import('npm:…')` argument. A specifier routed through a
 *    parameter — the `(spec) => import(spec)` shape these loaders used to share
 *    — ships `npm:` verbatim and cannot load on Node or Bun (X7-3). The
 *    repo-wide gate (`scripts/npm-specifier-audit.ts`) refuses a non-literal
 *    import anywhere under `packages/<pkg>/src`, so this test is the local,
 *    named guard for the five loaders that actually carried the defect.
 *
 * 2. **Agreement.** The literal cannot be replaced by the module constant (it
 *    has to sit at the `import()` for the rewrite to see it), so the specifier
 *    is written twice: once in the import and once in the reported
 *    `specifier`. Nothing else pins them together, and drifting the import
 *    alone is silent — the loader would import one version and report another.
 *    `grpc-plugin`'s `connect-loader.test.ts` has carried this guard since
 *    M70e; these five did not.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  loadFetchInstrumentation,
  loadHttpInstrumentation,
} from '../../src/instrumentation/http-instrumentation.ts';
import { loadIORedisInstrumentation } from '../../src/instrumentation/database-instrumentation.ts';
import {
  loadAmqplibInstrumentation,
  loadKafkaJsInstrumentation,
} from '../../src/instrumentation/queue-instrumentation.ts';

/** Each loader beside the specifier its default importer must name. */
const LOADERS: ReadonlyArray<
  readonly [name: string, loader: (...args: never[]) => unknown, specifier: string]
> = [
  ['http', loadHttpInstrumentation, 'npm:@opentelemetry/instrumentation-http@^0.220.0'],
  ['fetch', loadFetchInstrumentation, 'npm:@opentelemetry/instrumentation-undici@^0.30.0'],
  ['ioredis', loadIORedisInstrumentation, 'npm:@opentelemetry/instrumentation-ioredis@^0.68.0'],
  ['amqplib', loadAmqplibInstrumentation, 'npm:@opentelemetry/instrumentation-amqplib@^0.67.0'],
  ['kafkajs', loadKafkaJsInstrumentation, 'npm:@opentelemetry/instrumentation-kafkajs@^0.29.0'],
];

describe('instrumentation loaders — literal npm: specifiers', () => {
  for (const [name, loader, specifier] of LOADERS) {
    it(`keeps '${name}' as a literal import() argument in its default importer`, () => {
      // The default importer is a default PARAMETER, so it is part of the
      // function's own source text.
      expect(String(loader)).toContain(`import('${specifier}')`);
    });
  }

  it('reports the same specifier it imports', async () => {
    // Drives each loader with an injected importer so no npm package is
    // needed, then checks the REPORTED specifier against the literal asserted
    // above — the two copies cannot drift apart unnoticed.
    const reported = await Promise.all(
      LOADERS.map(async ([, loader, specifier]) => {
        const load = loader as unknown as (
          config: unknown,
          importFn: () => Promise<Record<string, unknown>>,
        ) => Promise<{ specifier: string }>;
        const result = await load(undefined, () =>
          Promise.resolve({
            HttpInstrumentation: class {},
            UndiciInstrumentation: class {},
            IORedisInstrumentation: class {},
            AmqplibInstrumentation: class {},
            KafkaJsInstrumentation: class {},
          }));
        return [result.specifier, specifier];
      }),
    );

    for (const [actual, expected] of reported) {
      expect(actual).toBe(expected);
    }
  });
});
