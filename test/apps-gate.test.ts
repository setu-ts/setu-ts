import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';
import {
  classifySmokeExitCode,
  malformedAppDirMessage,
  unexpectedSkips,
} from '../scripts/check-apps.ts';

interface RootConfig {
  readonly workspace: readonly string[];
}

interface AppConfig {
  readonly tasks?: Readonly<Record<string, string>>;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(path)) as T;
}

describe('application gate configuration', () => {
  it('keeps applications outside the published workspace', async () => {
    const root = await readJson<RootConfig>('deno.json');
    expect(root.workspace.some((entry) => entry.includes('apps'))).toBe(false);
  });

  it('requires every example application to declare start and smoke tasks', async () => {
    for await (const entry of Deno.readDir('apps')) {
      if (!entry.isDirectory) continue;
      const config = await readJson<AppConfig>(`apps/${entry.name}/deno.json`);
      expect(config.tasks?.start).toBeDefined();
      expect(config.tasks?.smoke).toBeDefined();
    }
  });

  it('keeps a documented smoke skip distinct from a passing smoke check', () => {
    expect(classifySmokeExitCode({ code: 77, success: false, signal: null }))
      .toBe('skipped');
    expect(classifySmokeExitCode({ code: 0, success: true, signal: null }))
      .toBe('passed');
  });
});

describe('unexpectedSkips', () => {
  it('returns empty array when no apps skipped', () => {
    expect(unexpectedSkips([], ['cloudflare'])).toEqual([]);
  });

  it('returns empty array when all skipped apps are in the allowlist', () => {
    expect(unexpectedSkips(['cloudflare'], ['cloudflare'])).toEqual([]);
  });

  it('returns the unexpected skips when allowlist does not cover them', () => {
    expect(
      unexpectedSkips(['realtime', 'cloudflare'], ['cloudflare']),
    ).toEqual(['realtime']);
  });

  it('treats every skip as unexpected when ALLOW_SKIP is set but lists nothing', () => {
    // Not the ALLOW_SKIP-unset case: checkApps() never calls this function when
    // the variable is absent, so warn-only mode is the caller's branch, not this one.
    expect(unexpectedSkips(['cloudflare'], [])).toEqual(['cloudflare']);
  });
});

describe('real-backend CI wiring', () => {
  // The three deepened Redis tests (cache/messaging/queue `redis-real-import`)
  // guard on REDIS_URL and log SKIP when it is absent. That guard is right for
  // local development and silent in CI: drop REDIS_URL from the workflow and all
  // three skip while the job stays green — precisely the "a skip a provided
  // backend should have covered is a regression, not a pass" failure that M53
  // fixes for `apps/`. These assertions extend the same rule to the package
  // tests M53 added, so the wiring cannot be removed without a red gate.

  it('declares a Redis service and REDIS_URL on the deno job', async () => {
    const workflow = await Deno.readTextFile('.github/workflows/ci.yml');
    expect(workflow).toContain('REDIS_URL: redis://localhost:6379');
    expect(workflow).toContain('image: redis:7');
    // The port mapping is load-bearing: the job runs directly on the runner,
    // where a service label is not a resolvable hostname and only a mapped port
    // on localhost is reachable.
    expect(workflow).toContain('- 6379:6379');
  });

  it('pins ElasticMQ image and declares SQS local-region/credentials', async () => {
    const workflow = await Deno.readTextFile('.github/workflows/ci.yml');
    // Pin the ElasticMQ image to avoid drift from `latest`
    expect(workflow).toContain('image: softwaremill/elasticmq-native:1.7.1');
    // SQS_ENDPOINT_URL must be present for the e2e test guard
    expect(workflow).toContain('SQS_ENDPOINT_URL: http://localhost:9324');
    // AWS SDK requires region and dummy credentials for local emulator
    expect(workflow).toContain('SQS_REGION: us-east-1');
    expect(workflow).toContain('AWS_ACCESS_KEY_ID: test');
    expect(workflow).toContain('AWS_SECRET_ACCESS_KEY: test');
  });

  it('grants each Redis package the net permission its guarded test needs', async () => {
    const redisPackages = ['cache-plugin', 'messaging-plugin'];
    for (const pkg of redisPackages) {
      const config = await readJson<{
        readonly test?: { readonly permissions?: { readonly net?: readonly string[] } };
      }>(`packages/${pkg}/deno.json`);
      // Scoped, not `true`: the grant exists for the Redis round trips alone.
      expect(config.test?.permissions?.net).toEqual(['127.0.0.1:6379', 'localhost:6379']);
    }
    // queue-plugin also needs ElasticMQ endpoints for SQS e2e.
    const queueConfig = await readJson<{
      readonly test?: { readonly permissions?: { readonly net?: readonly string[] } };
    }>('packages/queue-plugin/deno.json');
    expect(queueConfig.test?.permissions?.net).toEqual([
      '127.0.0.1:6379',
      'localhost:6379',
      '127.0.0.1:9324',
      'localhost:9324',
    ]);
  });

  it('does not exempt the full-stack example from the smoke gate', async () => {
    // M37c's whole toolchain decision was that the frontend build is CHEAP
    // enough to run for real (measured: ~4s install, <1s build under Deno's own
    // npm support), so the example needs neither a committed ServerBuild
    // fixture nor a Node toolchain in CI — and therefore no skip allowance.
    // Adding `full-stack` to ALLOW_SKIP would ship an example whose proof never
    // runs, which is the pattern M53 exists to end. Asserted rather than
    // trusted, because the exemption would be a one-word edit and CI would stay
    // green.
    const workflow = await Deno.readTextFile('.github/workflows/ci.yml');
    const allowSkip = /ALLOW_SKIP:\s*(.+)/.exec(workflow)?.[1] ?? '';
    expect(allowSkip.split(',').map((name) => name.trim())).not.toContain('full-stack');
  });

  it('has REDIS_URL available whenever CI provides the container', () => {
    // Vacuous locally by design; in CI it fails if the job env stops reaching
    // the test step, which the static checks above cannot observe.
    if (Deno.env.get('CI') === undefined) return;
    expect(Deno.env.get('REDIS_URL')).toBeDefined();
  });
});

describe('malformedAppDirMessage', () => {
  it('formats a missing deno.json message for NotFound', () => {
    const msg = malformedAppDirMessage(
      'foo',
      new Deno.errors.NotFound('ENOENT'),
    );
    expect(msg).toContain('foo');
    expect(msg).toContain('missing deno.json');
    expect(msg).toContain('malformed application directory');
  });

  it('formats an invalid JSON message for SyntaxError', () => {
    const msg = malformedAppDirMessage('bar', new SyntaxError('unexpected token'));
    expect(msg).toContain('bar');
    expect(msg).toContain('not valid JSON');
    expect(msg).toContain('malformed application directory');
  });

  it('returns null for an unknown error type', () => {
    const msg = malformedAppDirMessage('baz', new RangeError('out of range'));
    expect(msg).toBeNull();
  });
});
