/**
 * The per-runtime plugin swap.
 *
 * Its whole job is to be scoped: a swap that leaked onto another target would
 * scaffold a project registering `CloudflarePlugin` on Node, where there is no
 * `env` to hand it. So the tests below pin both halves — that Workers changes,
 * and that nothing else does.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { TargetRuntime } from '../../../src/constants.ts';
import { projectFiles, resolveHost } from '../../../src/templates/project-files.ts';
import type { TemplateHost } from '../../../src/templates/registry.ts';
import { MICROSERVICE_TEMPLATE } from '../../../src/templates/microservice.ts';
import { REST_TEMPLATE } from '../../../src/templates/rest.ts';

/** The bare package names a host registers on one runtime. */
function packagesOn(host: TemplateHost, runtime: TargetRuntime): readonly string[] {
  return resolveHost(host, runtime).plugins.map((wiring) => wiring.pkg);
}

/** One file's contents from a rendered project, or undefined. */
function fileAt(
  host: TemplateHost,
  runtime: TargetRuntime,
  path: string,
): string | undefined {
  const resolved = resolveHost(host, runtime);
  return projectFiles('proj', runtime, resolved).find((f) => f.path === path)?.contents;
}

describe('runtime swaps', () => {
  it('replaces the socket-bound brokers on Cloudflare Workers', () => {
    const workers = packagesOn(MICROSERVICE_TEMPLATE, 'cloudflare-workers');

    expect(workers).not.toContain('messaging-plugin');
    expect(workers).not.toContain('queue-plugin');
    expect(workers).toContain('cloudflare-plugin');
  });

  it('keeps every other plugin in the set, and its order', () => {
    const deno = packagesOn(MICROSERVICE_TEMPLATE, 'deno');
    const workers = packagesOn(MICROSERVICE_TEMPLATE, 'cloudflare-workers');

    const survivors = deno.filter((pkg) => pkg !== 'messaging-plugin' && pkg !== 'queue-plugin');
    // The swap appends, so the survivors keep their relative order and only the
    // replacement is new.
    expect(workers).toEqual([...survivors, 'cloudflare-plugin']);
  });

  it('leaves the other three runtimes byte-identical', () => {
    const deno = packagesOn(MICROSERVICE_TEMPLATE, 'deno');

    for (const runtime of ['node', 'bun'] as const) {
      expect(packagesOn(MICROSERVICE_TEMPLATE, runtime)).toEqual(deno);
    }
    expect(deno).toContain('messaging-plugin');
    expect(deno).toContain('queue-plugin');
    expect(deno).not.toContain('cloudflare-plugin');
  });

  it('leaves a template declaring no swap unchanged on every runtime', () => {
    const baseline = packagesOn(REST_TEMPLATE, 'deno');

    for (const runtime of ['node', 'bun', 'cloudflare-workers'] as const) {
      expect(packagesOn(REST_TEMPLATE, runtime)).toEqual(baseline);
    }
  });

  it('emits the swap files only on the runtime that swapped', () => {
    expect(fileAt(MICROSERVICE_TEMPLATE, 'cloudflare-workers', 'src/reply-inbox-object.ts'))
      .toContain('ReplyInboxObjectCore');
    expect(fileAt(MICROSERVICE_TEMPLATE, 'deno', 'src/reply-inbox-object.ts')).toBeUndefined();
  });

  it('appends the swap TOML to wrangler.toml, keeping the fixed header', () => {
    const wrangler = fileAt(MICROSERVICE_TEMPLATE, 'cloudflare-workers', 'wrangler.toml');

    expect(wrangler).toContain('compatibility_date');
    expect(wrangler).toContain('[[queues.producers]]');
    expect(wrangler).toContain('max_batch_timeout = 0');
  });

  // Cloudflare invokes ONE `queue` export for every queue a Worker consumes, so
  // a project serving messaging AND background jobs must tell them apart. One
  // handler for both would feed the messaging broker its job batches — which it
  // cannot read, so it retries them until the queue dead-letters them.
  it('routes each consumed queue to its own handler', () => {
    const entry = fileAt(MICROSERVICE_TEMPLATE, 'cloudflare-workers', 'src/index.ts') ?? '';

    expect(entry).toContain('switch (payload.queue)');
    expect(entry).toContain("case 'messages':");
    expect(entry).toContain('createMessagingHandler(app)(payload)');
    expect(entry).toContain("case 'jobs':");
    expect(entry).toContain('createQueueHandler(app)(payload)');
    // One import line for the package, not one per symbol — two would not compile.
    expect(entry).toContain(
      "import { createMessagingHandler, createQueueHandler } from '@setu-ts/cloudflare-plugin';",
    );
  });

  it('throws for a queue it has no handler for, rather than guessing', () => {
    const entry = fileAt(MICROSERVICE_TEMPLATE, 'cloudflare-workers', 'src/index.ts') ?? '';

    // Falling through to the first route would hand one queue's batches to the
    // other's handler; silently acking them would discard the work.
    expect(entry).toContain('default:');
    expect(entry).toContain('No handler is registered for queue');
  });

  it('consumes every queue it produces to', () => {
    const wrangler = fileAt(MICROSERVICE_TEMPLATE, 'cloudflare-workers', 'wrangler.toml') ?? '';

    // A producer with no consumer accepts `IQueue.add()` and discards the job
    // once retention elapses — silently, which is the failure a queue exists to
    // prevent.
    const produced = [
      ...wrangler.matchAll(/\[\[queues\.producers\]\]\nbinding = "[^"]+"\nqueue = "([^"]+)"/g),
    ]
      .map((match) => match[1]);
    const consumed = [...wrangler.matchAll(/\[\[queues\.consumers\]\]\nqueue = "([^"]+)"/g)]
      .map((match) => match[1]);

    expect(produced.length).toBeGreaterThan(0);
    expect([...produced].sort()).toEqual([...consumed].sort());
  });

  it('declares the queue export in the Workers entry, and nowhere else', () => {
    const entry = fileAt(MICROSERVICE_TEMPLATE, 'cloudflare-workers', 'src/index.ts');

    expect(entry).toContain('async queue(');
    // One boot, not two: a second application would carry its own broker and
    // its own dispatch table, and the subscriptions registered on one would be
    // invisible to the other.
    expect(entry?.match(/booted \?\?= boot\(env\)/g)).toHaveLength(2);
    expect(entry?.match(/async function boot/g)).toHaveLength(1);

    // The REST template contributes no export, so its entry is unchanged.
    expect(fileAt(REST_TEMPLATE, 'cloudflare-workers', 'src/index.ts')).not.toContain('queue(');
  });

  it('declares cloudflare-plugin in the generated manifest on Workers', () => {
    const manifest = fileAt(MICROSERVICE_TEMPLATE, 'cloudflare-workers', 'deno.json');

    // The renderer and the manifest writer are separate functions reading one
    // swapped plugin list; if they disagreed, the project would import a
    // package it never declared.
    expect(manifest).toContain('@setu-ts/cloudflare-plugin');
    expect(manifest).not.toContain('@setu-ts/messaging-plugin');
  });

  it('throws when a swap names a package the template does not register', () => {
    const broken: TemplateHost = {
      plugins: [{ pkg: 'runtime', symbol: 'RuntimePlugin' }],
      middleware: [],
      runtimeSwaps: {
        'cloudflare-workers': { removePackages: ['not-installed'], addPlugins: [] },
      },
    };

    // A defect in this repository's own template data, never something a user
    // can reach — and silently dropping it would leave a swap that no longer
    // removes what its author believed it did.
    expect(() => resolveHost(broken, 'cloudflare-workers')).toThrow('not-installed');
    expect(() => resolveHost(broken, 'deno')).not.toThrow();
  });
});
