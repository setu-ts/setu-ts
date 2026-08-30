import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';
import {
  classifySmokeExitCode,
  malformedAppDirMessage,
  prerequisiteTask,
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

  it('keeps the realtime-client exercise out of the CI skip allowlist', async () => {
    const workflow = await Deno.readTextFile('.github/workflows/ci.yml');
    // Scoped to the `deno` job, not the whole file: `node-compat` and
    // `bun-compat` declare the same two actions, so a repo-wide `toContain`
    // stays green after they are removed from the job that runs `check:apps`.
    const denoJob = workflow.slice(
      workflow.indexOf('\n  deno:'),
      workflow.indexOf('\n  publish-dry-run:'),
    );
    expect(denoJob).not.toBe('');
    expect(denoJob).toContain('actions/setup-node@v4');
    expect(denoJob).toContain('oven-sh/setup-bun@v2');
    const allowSkip = workflow.match(/ALLOW_SKIP:\s*([^\n]+)/)?.[1] ?? '';
    expect(allowSkip).not.toContain('realtime-clients');
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

describe('prerequisiteTask', () => {
  it('returns null when the app declares no install task', () => {
    expect(prerequisiteTask({ start: 'deno run main.ts', smoke: 'deno run smoke.ts' }))
      .toBeNull();
  });

  it('returns null when the app declares no tasks at all', () => {
    expect(prerequisiteTask(undefined)).toBeNull();
  });

  it('returns the install task when one is declared', () => {
    expect(prerequisiteTask({ install: 'deno install --allow-scripts' }))
      .toBe('install');
  });
});

describe('cold-checkout npm resolution', () => {
  it('gives every app carrying a package.json an install task to run first', async () => {
    // `check-apps.ts` type-checks an app BEFORE running the smoke that would
    // create `node_modules`, and a `package.json` switches Deno to
    // node_modules resolution — so on a cold checkout the check fails on an
    // npm specifier the example never declared, reached through the
    // framework's lazily-imported optional drivers. `prerequisiteTask` fixes
    // the ordering by running the app's OWN declared install task first, which
    // means an app with a `package.json` and no such task silently keeps the
    // bug. Asserted here because a warm tree proves nothing: every local run
    // passes once `node_modules` exists from any earlier build.
    for await (const entry of Deno.readDir('apps')) {
      if (!entry.isDirectory) continue;
      let hasPackageJson = true;
      try {
        await Deno.stat(`apps/${entry.name}/package.json`);
      } catch (error) {
        // Only absence means "no npm toolchain here". Any other stat failure
        // is a real problem, and swallowing it would skip the app and pass
        // the assertion vacuously — `check-apps.ts` itself rethrows a
        // non-NotFound error from the equivalent `worker.ts` probe.
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        hasPackageJson = false;
      }
      if (!hasPackageJson) continue;

      const config = await readJson<AppConfig>(`apps/${entry.name}/deno.json`);
      expect(prerequisiteTask(config.tasks)).toBe('install');
    }
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

  it('declares the Mongo service, URI, and scoped database-plugin permission', async () => {
    for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
      const workflowText = await Deno.readTextFile(workflow);
      expect(workflowText).toContain('MONGODB_URI: mongodb://127.0.0.1:27017');
      expect(workflowText).toContain('image: mongo:8');
      expect(workflowText).toContain('- 27017:27017');
    }
    const config = await readJson<{
      readonly test?: { readonly permissions?: { readonly net?: readonly string[] } };
    }>('packages/database-plugin/deno.json');
    expect(config.test?.permissions?.net).toEqual([
      '127.0.0.1:27017',
      'localhost:27017',
    ]);
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

  it('pins the RabbitMQ service at major version 4 (M70l §3.1)', async () => {
    const workflow = await Deno.readTextFile('.github/workflows/ci.yml');
    const rabbitLine = workflow
      .split('\n')
      .find((line) => line.trim().startsWith('image: rabbitmq:'));
    expect(rabbitLine).toBeDefined();
    // 3.13 accepts the pre-M70l queue declaration, so X10-1 is INVISIBLE
    // there — pointing CI back at major version 3 makes the declaration
    // suite pass vacuously. The gate cannot be silently reverted.
    expect(rabbitLine).toMatch(/image: rabbitmq:(4|-)/);
    expect(rabbitLine).not.toContain('rabbitmq:3');
  });

  it('grants each Redis package the net permission its guarded test needs', async () => {
    const redisPackages = ['cache-plugin', 'messaging-plugin'];
    for (const pkg of redisPackages) {
      const config = await readJson<{
        readonly test?: { readonly permissions?: { readonly net?: readonly string[] } };
      }>(`packages/${pkg}/deno.json`);
      // Scoped, not `true`: the grant exists for the Redis round trips alone.
      // messaging-plugin also carries the RabbitMQ outage suite (M70c §3.7),
      // so it grants the AMQP port too — plus the two cloud emulators
      // `docs/messaging-emulators.md` documents, without which their e2e suites
      // cannot pass under `deno task test` at all (they failed with
      // `getaddrinfo EPERM` and gRPC `Name resolution failed` while the doc's
      // standalone `--allow-all` command hid it).
      //
      // 5673 rather than the emulator's own 5672, which RabbitMQ already holds.
      // Still endpoint-scoped, never loopback-wide: the Pub/Sub suite addresses
      // the emulator as `127.0.0.1:8085` so grpc-js skips the DNS lookup a
      // `host:port` grant does not authorize, which is what avoids the bare
      // `localhost` entry M53 rejected.
      if (pkg === 'messaging-plugin') {
        expect(config.test?.permissions?.net).toEqual([
          '127.0.0.1:6379',
          'localhost:6379',
          '127.0.0.1:5672',
          'localhost:5672',
          '127.0.0.1:5673',
          'localhost:5673',
          '127.0.0.1:8085',
          'localhost:8085',
        ]);
      } else {
        expect(config.test?.permissions?.net).toEqual(['127.0.0.1:6379', 'localhost:6379']);
      }
    }
    // queue-plugin also needs ElasticMQ endpoints for SQS e2e and the
    // RabbitMQ port for the M70c §3.7 queue outage suite.
    const queueConfig = await readJson<{
      readonly test?: { readonly permissions?: { readonly net?: readonly string[] } };
    }>('packages/queue-plugin/deno.json');
    expect(queueConfig.test?.permissions?.net).toEqual([
      '127.0.0.1:6379',
      'localhost:6379',
      '127.0.0.1:9324',
      'localhost:9324',
      '127.0.0.1:5672',
      'localhost:5672',
    ]);
  });

  it('pins the M70c §3.7 real-outage services, ports, and env vars', async () => {
    // The five §3.7 outage-real.test.ts suites guard on RABBITMQ_URL /
    // REDIS_URL / S3_ENDPOINT_URL / SMTP_URL and are NOT in ALLOW_SKIP, so a
    // dropped service or a missing var must fail CI, not skip. These pins keep
    // the service, the port mapping, and the env var from drifting.
    for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
      const text = await Deno.readTextFile(workflow);
      // RabbitMQ (messaging broker + queue outage suites). Major version 4 is
      // load-bearing since M70l §3.1 — 3.13 accepts the queue declaration the
      // defect lives in, so a revert to 3 makes those suites pass vacuously.
      expect(text).toContain('image: rabbitmq:4-management-alpine');
      expect(text).toContain('- 5672:5672');
      expect(text).toContain('RABBITMQ_URL: amqp://localhost:5672');
      // MinIO (storage S3 outage suite)
      expect(text).toContain('image: minio/minio:edge-cicd');
      // A service container takes no `command`/`environment` key, so a block
      // carrying either is an invalid workflow — and the text pins above would
      // still pass. Assert their absence too.
      expect(text).not.toMatch(/^\s+command:/m);
      expect(text).not.toMatch(/^\s+environment:/m);
      expect(text).toContain('- 9000:9000');
      expect(text).toContain('S3_ENDPOINT_URL: http://localhost:9000');
      // Mailpit (mail SMTP outage suite)
      expect(text).toContain('image: axllent/mailpit:v1.20.4');
      expect(text).toContain('- 1025:1025');
      expect(text).toContain('SMTP_URL: smtp://localhost:1025');
    }
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

  it('declares the same backend wiring on the release job', async () => {
    // GitHub sets CI=true in EVERY workflow, so the runtime assertion below
    // fires in release.yml exactly as it does in ci.yml — and release.yml runs
    // this same suite before publishing. It shipped without the service block,
    // so the v0.1.0-alpha.5 release run died on that assertion and the release
    // was published by hand. The two workflows must therefore agree on the
    // backend environment, not merely on which tasks they call.
    const workflow = await Deno.readTextFile('.github/workflows/release.yml');
    expect(workflow).toContain('REDIS_URL: redis://localhost:6379');
    expect(workflow).toContain('image: redis:7');
    expect(workflow).toContain('- 6379:6379');
    expect(workflow).toContain('image: softwaremill/elasticmq-native:1.7.1');
    expect(workflow).toContain('SQS_ENDPOINT_URL: http://localhost:9324');
  });

  it('has REDIS_URL available whenever CI provides the container', () => {
    // Vacuous locally by design; in CI it fails if the job env stops reaching
    // the test step, which the static checks above cannot observe. Every
    // workflow running this suite must therefore provide the container — see
    // the release-job assertion above.
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
