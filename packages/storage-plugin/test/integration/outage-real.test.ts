import { run as runProcess } from '../../../../test/node-helpers.ts';
/**
 * §3.7 real-outage bar: drives a **real** MinIO (S3-compatible) backend
 * through a **real** stop and restart, asserting `up → (stop) down → (restart) up`.
 *
 * Guarded on `S3_ENDPOINT_URL`: absent it, this suite skips. `ALLOW_SKIP` does
 * not apply here — that variable is read only by `scripts/check-apps.ts` and
 * governs `apps/`. What keeps this suite honest is `test/apps-gate.test.ts`,
 * which pins the service, port mapping and env var in both workflows.
 * `test/apps-gate.test.ts` pins the service, port mapping, and env var.
 *
 * F1 regression: without `forcePathStyle: true` the AWS SDK uses virtual-host
 * addressing against the custom endpoint and every request fails (400
 * MalformedXML / 404 NoSuchBucket), so the probe reports `down` for a live
 * bucket. This suite would fail at the baseline `up` assertion if F1 regresses.
 */
import { describe, expect, it } from 'vitest';
import { S3Provider } from '../../src/providers/s3-provider.ts';

// ── Docker stop/start helpers ───────────────────────────────────────────────

async function docker(args: string[]): Promise<string> {
  const out = await runProcess('docker', { args });
  if (!out.success) {
    throw new Error(`docker ${args.join(' ')} failed: ${new TextDecoder().decode(out.stderr)}`);
  }
  return new TextDecoder().decode(out.stdout);
}

async function containerIdForPort(port: number): Promise<string> {
  const shard = process.env['SETU_CI_SHARD'];
  const filters = shard
    ? ['--filter', `label=setu.ci.shard=${shard}`, '--filter', `label=setu.ci.port.${port}=1`]
    : ['--filter', `publish=${port}`];
  const ids = (await docker(['ps', '-q', ...filters])).trim();
  if (ids === '') {
    throw new Error(`no container publishing port ${port}`);
  }
  return ids.split('\n')[0];
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitTrue(
  pred: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await wait(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function toIpv4(url: string): string {
  return url.replace(/localhost/g, '127.0.0.1');
}

/**
 * Ensures the bucket exists (creating it on a fresh backend, e.g. the CI
 * MinIO service, which starts with no buckets). The `head('')` probe is a
 * bucket-level reachability check, so it needs a bucket to answer against.
 * Uses the same SDK the provider loads, with the same `forcePathStyle` the
 * F1 fix applies to the provider's own client.
 */
async function ensureBucket(
  endpoint: string,
  bucket: string,
  accessKeyId: string,
  secretAccessKey: string,
): Promise<void> {
  const mod = await import('@aws-sdk/client-s3');
  const client = new mod.S3Client({
    endpoint: toIpv4(endpoint),
    region: 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
  try {
    await client.send(new mod.HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new mod.CreateBucketCommand({ Bucket: bucket }));
  }
}

describe('REAL MinIO/S3 outage (§3.7)', () => {
  it(
    'up → stop → down → restart → up',
    { skip: process.env['S3_ENDPOINT_URL'] === undefined },
    async () => {
      const endpoint = process.env['S3_ENDPOINT_URL'];
      if (endpoint === undefined) throw new Error('Backend guard failed');

      await import('@aws-sdk/client-s3');

      const port = new URL(endpoint).port === '' ? 9000 : Number(new URL(endpoint).port);
      const containerId = await containerIdForPort(port);

      const bucket = process.env['S3_BUCKET'] ?? 'm70c-verify';
      const accessKeyId = process.env['S3_ACCESS_KEY_ID'] ?? 'minioadmin';
      const secretAccessKey = process.env['S3_SECRET_ACCESS_KEY'] ?? 'minioadmin';

      await ensureBucket(endpoint, bucket, accessKeyId, secretAccessKey);

      const provider = new S3Provider({
        bucket,
        endpoint: toIpv4(endpoint),
        region: 'us-east-1',
        accessKeyId,
        secretAccessKey,
      });

      try {
        await provider.connect();
        expect(provider.isReady()).toBe(true);

        // (up) baseline: F1 regression — forcePathStyle must be set for custom
        // endpoints; without it the probe reports down for a live bucket.
        await waitTrue(async () => (await provider.isHealthy()) === true, 'up baseline', 15_000);
        expect(await provider.isHealthy()).toBe(true);

        // (stop) real MinIO stop → probe reports down
        await docker(['stop', containerId]);
        await waitTrue(
          async () => (await provider.isHealthy()) === false,
          'down after stop',
          30_000,
        );
        expect(await provider.isHealthy()).toBe(false);

        // (restart) real MinIO start → probe reports up
        await docker(['start', containerId]);
        await waitTrue(
          async () => (await provider.isHealthy()) === true,
          'up after restart',
          30_000,
        );
        expect(await provider.isHealthy()).toBe(true);
      } finally {
        await provider.disconnect();
        await runProcess('docker', { args: ['start', containerId] });
      }
    },
  );
});
