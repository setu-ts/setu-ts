import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../../scripts/lib/run.ts';
import { freePort, startHost, stopHost, waitForHttp } from '../smoke-helpers.ts';
import type { Host } from '../smoke-helpers.ts';

const BINARY = fileURLToPath(new URL('../../.tmp/compiled-binary/server', import.meta.url));

describe('compiled-binary example', () => {
  let server: Host;
  let baseUrl: string;

  before(async () => {
    const built = await run('pnpm', ['run', 'build:sea'], { inherit: true });
    assert.equal(built.code, 0, 'the single-executable build failed');
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = startHost(BINARY, [String(port)]);
    await waitForHttp(`${baseUrl}/health`, { label: 'The compiled executable' });
  });

  after(async () => {
    await stopHost(server);
  });

  it('serves /health from the standalone executable', async () => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });
});
