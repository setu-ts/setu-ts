// deno-lint-ignore-file no-console -- a boot probe reports its verdict on stdout/stderr.
// Runs on Node 24, Node 22 and Bun against the PACKED tarballs (M111a §3.10).
// Prints exactly one line starting `BOOT-OK ` on success; anything else is a
// failure, which the gate reports with this process's output.
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DecoratorPlugin } from '@setu-ts/decorator-plugin';
import { DecoratedController } from './dist/controller.js';

import { readFileSync } from 'node:fs';
const packages = Object.keys(
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).dependencies,
).filter((name) => name.startsWith('@setu-ts/'));
if (packages.length !== 51) {
  throw new Error(`Expected 51 installed members, found ${packages.length}`);
}
for (const name of packages) {
  const surface = await import(name);
  if (Object.keys(surface).length === 0) throw new Error(`${name} exposes no surface`);
}
console.log(`IMPORTED-OK ${packages.length} installed npm packages`);
const port = Number(process.argv[2]);
const app = createApplication({
  plugins: [RuntimePlugin(), DecoratorPlugin({ controllers: [DecoratedController] })],
});
app.router.get('/json', (ctx) => ctx.response.json({ ok: true }));
await app.start({ port });

async function read(path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.json() };
}

let failure;
try {
  const plain = await read('/json');
  const decorated = await read('/decorated');
  if (plain.status !== 200 || plain.body.ok !== true) {
    failure = `/json answered ${JSON.stringify(plain)}`;
  } else if (decorated.status !== 200 || decorated.body.decorated !== true) {
    failure = `/decorated answered ${JSON.stringify(decorated)}`;
  } else {
    console.log(
      `BOOT-OK ${
        JSON.stringify({ imported: packages.length, json: plain.body, decorated: decorated.body })
      }`,
    );
  }
} catch (error) {
  failure = String(error?.stack ?? error);
} finally {
  await app.stop();
}
if (failure !== undefined) {
  console.error(`BOOT-FAILED ${failure}`);
  process.exit(1);
}
process.exit(0);
