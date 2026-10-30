import { readFileSync } from 'node:fs';
/**
 * The package specifier of every instrumentation loader must be a LITERAL at
 * its own `import()` call, and must agree with the specifier the loader reports.
 *
 * Two properties, one test, because each hides a different defect:
 *
 * 1. **Literal.** Static analysis — a bundler, the type checker, the repo's
 *    import audit — sees only a literal `import('…')` argument. A specifier
 *    routed through a parameter — the `(spec) => import(spec)` shape these
 *    loaders used to share — hid the dependency from the published artifact
 *    (X7-3). The repo-wide gate (`scripts/npm-specifier-audit.ts`) refuses a
 *    non-literal import anywhere under `packages/<pkg>/src`, so this test is the
 *    local, named guard for the five loaders that actually carried the defect.
 *
 * 2. **Agreement.** The literal cannot be replaced by the module constant (it
 *    has to sit at the `import()` for static analysis to see it), so the specifier
 *    is written twice: once in the import and once in the reported
 *    `specifier`. Nothing else pins them together, and drifting the import
 *    alone is silent — the loader would import one version and report another.
 *    `grpc-plugin`'s `connect-loader.test.ts` has carried this guard since
 *    M70e; these five did not.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import {
  loadFetchInstrumentation,
  loadHttpInstrumentation,
} from '../../src/instrumentation/http-instrumentation.ts';
import {
  loadIORedisInstrumentation,
  loadRedisInstrumentation,
} from '../../src/instrumentation/database-instrumentation.ts';
import {
  loadAmqplibInstrumentation,
  loadKafkaJsInstrumentation,
} from '../../src/instrumentation/queue-instrumentation.ts';

/** Each loader beside the specifier its default importer must name. */
const LOADERS: ReadonlyArray<
  readonly [name: string, loader: (...args: never[]) => unknown, specifier: string]
> = [
  ['http', loadHttpInstrumentation, '@opentelemetry/instrumentation-http'],
  ['fetch', loadFetchInstrumentation, '@opentelemetry/instrumentation-undici'],
  ['ioredis', loadIORedisInstrumentation, '@opentelemetry/instrumentation-ioredis'],
  ['redis', loadRedisInstrumentation, '@opentelemetry/instrumentation-redis'],
  ['amqplib', loadAmqplibInstrumentation, '@opentelemetry/instrumentation-amqplib'],
  ['kafkajs', loadKafkaJsInstrumentation, '@opentelemetry/instrumentation-kafkajs'],
];

describe('instrumentation loaders — literal package specifiers', () => {
  for (const [name, , specifier] of LOADERS) {
    it(`keeps '${name}' as a literal import() argument in its default importer`, () => {
      // The default importer is a default PARAMETER, so it is part of the
      // function's own source text.
      const file =
        name === 'http' || name === 'fetch'
          ? 'http'
          : name === 'ioredis' || name === 'redis'
            ? 'database'
            : 'queue';
      const source = readFileSync(
        new URL(`../../src/instrumentation/${file}-instrumentation.ts`, import.meta.url),
        'utf8',
      );
      expect(source).toContain(`import('${specifier}')`);
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
            RedisInstrumentation: class {},
            AmqplibInstrumentation: class {},
            KafkaJsInstrumentation: class {},
          }),
        );
        return [result.specifier, specifier];
      }),
    );

    for (const [actual, expected] of reported) {
      expect(actual).toBe(expected);
    }
  });
});
