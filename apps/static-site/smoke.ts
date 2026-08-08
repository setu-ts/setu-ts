// deno-lint-ignore-file no-console
/**
 * Smoke check for the static-file example.
 *
 * Beyond the happy path, this drives the four behaviours that a code review of
 * M55 found broken — a HEAD that opened (and leaked) a body stream, a hashed
 * asset that lost its `immutable` policy when the brotli sidecar was served,
 * and an interrupted download that could never resume because the ETag was
 * weak. A smoke that only requests the paths its author already believed
 * worked is not coverage, so each of those is requested explicitly here.
 */
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { StaticPlugin } from '@setu-ts/static-plugin';

let failures = 0;

/** Asserts a condition, recording rather than throwing so one run reports every failure. */
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures++;
  console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

async function main() {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      StaticPlugin({
        root: './public',
        urlPrefix: '/',
        fallback: 'index.html',
        // Deliberately tiny so every response takes the STREAMING path rather
        // than the buffered one. Without this the example would exercise only
        // `readFile`, and the `readStream` seam — the milestone's headline
        // deliverable — would go untested end to end.
        maxBufferBytes: 4,
      }),
    ],
  });

  await app.start({ port: 0 });

  // ---------------------------------------------------------------- serving
  const index = await app.fetch(new Request('http://localhost/index.html'));
  check('serves index.html', index.status === 200, `status ${index.status}`);
  check(
    'index.html carries a content type',
    index.headers.get('Content-Type') === 'text/html',
    `got ${index.headers.get('Content-Type')}`,
  );
  await index.body?.cancel();

  // ------------------------------------------------------ conditional (304)
  const first = await app.fetch(new Request('http://localhost/index.html'));
  const etag = first.headers.get('ETag');
  await first.body?.cancel();
  check('issues an ETag', etag !== null);

  const revalidated = await app.fetch(
    new Request('http://localhost/index.html', {
      headers: { 'If-None-Match': etag ?? '' },
    }),
  );
  check(
    'revalidates to 304',
    revalidated.status === 304,
    `status ${revalidated.status}`,
  );
  await revalidated.body?.cancel();

  // ------------------------------------------------------------ SPA fallback
  const fallback = await app.fetch(
    new Request('http://localhost/nonexistent', {
      headers: { Accept: 'text/html' },
    }),
  );
  check('serves the SPA fallback for an HTML request', fallback.status === 200);
  await fallback.body?.cancel();

  const missingAsset = await app.fetch(
    new Request('http://localhost/nonexistent.js', {
      headers: { Accept: '*/*' },
    }),
  );
  check(
    'does NOT serve the fallback for a non-HTML request',
    missingAsset.status === 404,
    `status ${missingAsset.status} — an HTML shell under a JS content type is the classic SPA bug`,
  );
  await missingAsset.body?.cancel();

  // -------------------------------------------------------------------- HEAD
  const head = await app.fetch(
    new Request('http://localhost/test.txt', { method: 'HEAD' }),
  );
  const headBody = await head.arrayBuffer();
  check('HEAD answers 200', head.status === 200, `status ${head.status}`);
  check(
    'HEAD carries Content-Length',
    head.headers.get('Content-Length') === '12',
  );
  check(
    'HEAD has an empty body',
    headBody.byteLength === 0,
    `${headBody.byteLength} bytes`,
  );

  // ------------------------------------------------- resuming an interrupted
  //                                                    download (Range + If-Range)
  const full = await app.fetch(new Request('http://localhost/test.txt'));
  const fullEtag = full.headers.get('ETag') ?? '';
  const fullBody = await full.text();
  check(
    'full file body is intact',
    fullBody === 'hello world\n',
    JSON.stringify(fullBody),
  );
  check(
    'ETag is STRONG so If-Range can authorize a resume',
    !fullEtag.startsWith('W/'),
    `got ${fullEtag} — a weak validator makes the server ignore If-Range`,
  );

  const resumed = await app.fetch(
    new Request('http://localhost/test.txt', {
      headers: { Range: 'bytes=6-', 'If-Range': fullEtag },
    }),
  );
  const resumedBody = await resumed.text();
  check(
    'resumes with 206 rather than restarting',
    resumed.status === 206,
    `status ${resumed.status}`,
  );
  check(
    'Content-Range describes the resumed slice',
    resumed.headers.get('Content-Range') === 'bytes 6-11/12',
    `got ${resumed.headers.get('Content-Range')}`,
  );
  check(
    'resumed bytes continue the file',
    resumedBody === 'world\n',
    JSON.stringify(resumedBody),
  );

  const stale = await app.fetch(
    new Request('http://localhost/test.txt', {
      headers: { Range: 'bytes=6-', 'If-Range': '"999-1"' },
    }),
  );
  check(
    'a stale If-Range forces the whole file',
    stale.status === 200,
    `status ${stale.status}`,
  );
  await stale.body?.cancel();

  const unsatisfiable = await app.fetch(
    new Request('http://localhost/test.txt', {
      headers: { Range: 'bytes=9999-' },
    }),
  );
  check('an out-of-range request answers 416', unsatisfiable.status === 416);
  check(
    '416 reports the true size',
    unsatisfiable.headers.get('Content-Range') === 'bytes */12',
    `got ${unsatisfiable.headers.get('Content-Range')}`,
  );
  await unsatisfiable.body?.cancel();

  // --------------------------------------------- precompressed sidecar + cache
  const identity = await app.fetch(
    new Request('http://localhost/assets/app-a1b2c3d4.js'),
  );
  const identityEtag = identity.headers.get('ETag');
  const identityCache = identity.headers.get('Cache-Control');
  await identity.body?.cancel();
  check(
    'a content-hashed asset is immutable when served identity',
    identityCache === 'public, max-age=31536000, immutable',
    `got ${identityCache}`,
  );

  const brotli = await app.fetch(
    new Request('http://localhost/assets/app-a1b2c3d4.js', {
      headers: { 'Accept-Encoding': 'br' },
    }),
  );
  const brotliBytes = new Uint8Array(await brotli.arrayBuffer());
  check(
    'negotiates the brotli sidecar',
    brotli.headers.get('Content-Encoding') === 'br',
    `got ${brotli.headers.get('Content-Encoding')}`,
  );
  check(
    'keeps the original content type for the sidecar',
    brotli.headers.get('Content-Type') === 'text/javascript',
    `got ${brotli.headers.get('Content-Type')}`,
  );
  check(
    'marks the response as varying on Accept-Encoding',
    brotli.headers.get('Vary') === 'Accept-Encoding',
  );
  check(
    'the sidecar keeps the immutable policy of the original asset',
    brotli.headers.get('Cache-Control') ===
      'public, max-age=31536000, immutable',
    `got ${brotli.headers.get('Cache-Control')} — resolving from the '.js.br' path loses it`,
  );
  check(
    'the sidecar has its OWN ETag',
    brotli.headers.get('ETag') !== identityEtag,
    'sharing the original ETag across two byte streams poisons caches',
  );

  // The bytes on the wire really are the compressed sidecar, not the source.
  const sidecarSize = (await Deno.stat('./public/assets/app-a1b2c3d4.js.br')).size;
  check(
    'serves the compressed bytes',
    brotliBytes.byteLength === sidecarSize,
    `${brotliBytes.byteLength} bytes on the wire vs ${sidecarSize} on disk`,
  );

  const refused = await app.fetch(
    new Request('http://localhost/assets/app-a1b2c3d4.js', {
      headers: { 'Accept-Encoding': 'br;q=0, *' },
    }),
  );
  check(
    'an explicit br;q=0 refuses brotli despite the wildcard',
    refused.headers.get('Content-Encoding') === null,
    `got ${refused.headers.get('Content-Encoding')}`,
  );
  await refused.body?.cancel();

  // ---------------------------------------------------------------- traversal
  const traversal = await app.fetch(
    new Request('http://localhost/../deno.json'),
  );
  check(
    'refuses path traversal',
    traversal.status === 404,
    `status ${traversal.status}`,
  );
  await traversal.body?.cancel();

  await app.stop();

  if (failures > 0) {
    console.error(`\n${failures} smoke check(s) failed`);
    Deno.exit(1);
  }
  console.log('\nAll smoke tests passed');
}

await main();
