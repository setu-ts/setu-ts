/**
 * REAL-filesystem tests for `IFileSystem.readStream`.
 *
 * These deliberately use each adapter's DEFAULT host — `buildNodeHost()` and
 * `buildBunHost()` with no arguments, and the real `Deno` global — rather than
 * an injected fake. That is the entire point: the unit tests inject a host that
 * supplies `createReadStream`, so they pass whether or not the default host can
 * actually produce a stream. Both the Node and Bun adapters shipped a
 * permanently-throwing `readStream` behind exactly that gap — Node because
 * `node:fs/promises` exports no `createReadStream`, and Bun because its default
 * host never exposed one — and no injected-host test could see it.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { buildNodeHost, createNodeRuntimeServices } from '../../src/adapters/node/node-runtime.ts';
import { buildBunHost, createBunRuntimeServices } from '../../src/adapters/bun/bun-runtime.ts';
import { createDenoRuntimeServices } from '../../src/adapters/deno/deno-runtime.ts';

/** Deterministic body: 256 bytes, each equal to its own index. */
const BODY = new Uint8Array(256).map((_, i) => i);

/** Writes {@link BODY} to a fresh temp file and returns its path. */
async function writeFixture(): Promise<string> {
  const path = await Deno.makeTempFile({ prefix: 'setu-readstream-' });
  await Deno.writeFile(path, BODY);
  return path;
}

/** Drains a stream into one buffer. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

describe('readStream against the real filesystem — Node default host', () => {
  it('streams a whole file through buildNodeHost() with no injected modules', async () => {
    const path = await writeFixture();
    try {
      const fs = createNodeRuntimeServices(buildNodeHost()).fs;
      expect(fs?.readStream).toBeDefined();

      const bytes = await drain(await fs!.readStream!(path));
      expect(bytes.length).toBe(BODY.length);
      expect(Array.from(bytes.slice(0, 4))).toEqual([0, 1, 2, 3]);
      expect(Array.from(bytes.slice(-2))).toEqual([254, 255]);
    } finally {
      await Deno.remove(path);
    }
  });

  it('honours an inclusive byte range through the default host', async () => {
    const path = await writeFixture();
    try {
      const fs = createNodeRuntimeServices(buildNodeHost()).fs;
      const bytes = await drain(await fs!.readStream!(path, { start: 10, end: 19 }));

      // `end` is INCLUSIVE, so 10..19 is 10 bytes.
      expect(bytes.length).toBe(10);
      expect(Array.from(bytes)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    } finally {
      await Deno.remove(path);
    }
  });
});

describe('readStream against the real filesystem — Bun default host', () => {
  it('streams a whole file through buildBunHost() with no injected modules', async () => {
    const path = await writeFixture();
    try {
      const fs = createBunRuntimeServices(buildBunHost()).fs;
      expect(fs?.readStream).toBeDefined();

      const bytes = await drain(await fs!.readStream!(path));
      expect(bytes.length).toBe(BODY.length);
      expect(Array.from(bytes.slice(0, 4))).toEqual([0, 1, 2, 3]);
    } finally {
      await Deno.remove(path);
    }
  });

  it('honours an inclusive byte range through the default host', async () => {
    const path = await writeFixture();
    try {
      const fs = createBunRuntimeServices(buildBunHost()).fs;
      const bytes = await drain(await fs!.readStream!(path, { start: 200, end: 209 }));

      expect(bytes.length).toBe(10);
      expect(Array.from(bytes)).toEqual([200, 201, 202, 203, 204, 205, 206, 207, 208, 209]);
    } finally {
      await Deno.remove(path);
    }
  });
});

describe('readStream against the real filesystem — Deno', () => {
  it('streams a whole file through the real Deno global', async () => {
    const path = await writeFixture();
    try {
      const fs = createDenoRuntimeServices().fs;
      const bytes = await drain(await fs!.readStream!(path));

      expect(bytes.length).toBe(BODY.length);
      expect(Array.from(bytes.slice(-2))).toEqual([254, 255]);
    } finally {
      await Deno.remove(path);
    }
  });

  it('honours an inclusive byte range and terminates at the limit', async () => {
    const path = await writeFixture();
    try {
      const fs = createDenoRuntimeServices().fs;
      const bytes = await drain(await fs!.readStream!(path, { start: 0, end: 3 }));

      expect(bytes.length).toBe(4);
      expect(Array.from(bytes)).toEqual([0, 1, 2, 3]);
    } finally {
      await Deno.remove(path);
    }
  });

  it('reads to end of file when only start is given', async () => {
    const path = await writeFixture();
    try {
      const fs = createDenoRuntimeServices().fs;
      const bytes = await drain(await fs!.readStream!(path, { start: 250 }));

      expect(bytes.length).toBe(6);
      expect(Array.from(bytes)).toEqual([250, 251, 252, 253, 254, 255]);
    } finally {
      await Deno.remove(path);
    }
  });
});
