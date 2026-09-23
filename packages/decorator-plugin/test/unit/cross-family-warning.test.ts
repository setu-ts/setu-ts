// deno-lint-ignore-file no-console -- the real ConsoleLogger's sink under test IS `console.log`.
/**
 * Cross-family misregistration diagnostic (M99d §3.1/§3.3).
 *
 * A class that carries BOTH an HTTP decorator (`@Get`) and a non-HTTP ingress
 * decorator (`@Processor`) but is listed in only ONE of `controllers` /
 * `ingress` has half of its composition silently ignored: the list it was given
 * registers only that one family. Measured, not inferred (§1):
 * `controllers`-only answers its routes `200` and never fires the processor;
 * `ingress`-only fires the processor and answers its routes `404`; both lists
 * give both. No diagnostic in any of the three.
 *
 * The existing M64 warning cannot cover this: the class legitimately HAS
 * `@Controller` metadata, so `hasController` sees nothing wrong. This suite
 * drives a REAL `LoggerPlugin` (its ConsoleLogger sink is `console.log`,
 * captured here) rather than a fake sink, because the M64 warning is invisible
 * without a real logger and a fixture asserting on a fake sink would not have
 * caught that.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IJob, IQueue } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { LoggerPlugin } from '@setu-ts/logger-plugin';
import { QueuePlugin } from '@setu-ts/queue-plugin';
import { RuntimePlugin } from '@setu-ts/runtime';

import { Controller, Get, Module, Processor } from '../../src/index.ts';
import { DecoratorPlugin } from '../../src/plugin/decorator-plugin.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';
import type { DecoratorPluginOptions } from '../../src/plugin/decorator-plugin.ts';

/** The two cross-family diagnostics, by exact message. */
const CONTROLLERS_SIDE =
  'Class is registered as a controller but carries non-HTTP ingress metadata; its ingress decorators are ignored';
const INGRESS_SIDE =
  'Class is listed in `ingress` and carries HTTP route metadata but is not registered as a controller; its routes are not registered';

/** Captures the JSON lines the real ConsoleLogger writes to `console.log`. */
function captureConsole(): { lines: Record<string, unknown>[]; restore: () => void } {
  const lines: Record<string, unknown>[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    try {
      lines.push(JSON.parse(text) as Record<string, unknown>);
    } catch {
      real(...args);
    }
  };
  return {
    lines,
    restore: () => {
      console.log = real;
    },
  };
}

async function until(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

/** Settles long enough for a memory-queue processor (5 ms poll) to fire if one is registered. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

interface Booted {
  readonly app: ReturnType<typeof createApplication>;
  readonly lines: Record<string, unknown>[];
  readonly restore: () => void;
}

/**
 * Boots one application with the REAL LoggerPlugin, QueuePlugin (memory) and a
 * DecoratorPlugin carrying the given options, capturing every `console.log`
 * line the ConsoleLogger emits. The cross-family warning is emitted at
 * `register()` time, i.e. during `app.start()`.
 */
async function boot(options: DecoratorPluginOptions): Promise<Booted> {
  const captured = captureConsole();
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      LoggerPlugin(),
      QueuePlugin({ adapter: 'memory', pollIntervalMs: 5 }),
      DecoratorPlugin(options),
    ],
  });
  await app.start();
  return { app, lines: captured.lines, restore: captured.restore };
}

/** The two cross-family lines among the captured console output. */
function crossFamily(lines: Record<string, unknown>[]): Record<string, unknown>[] {
  return lines.filter((line) => line['msg'] === CONTROLLERS_SIDE || line['msg'] === INGRESS_SIDE);
}

describe('cross-family misregistration warning (M99d)', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('controllers-only: warns naming `ingress`, serves the route, never fires the processor', async () => {
    const received: string[] = [];
    @Controller('/mixed')
    class Both {
      @Get('/')
      read() {
        return { ok: true };
      }

      @Processor('m99d-job')
      process(job: IJob<{ readonly id: string }>) {
        received.push(job.data.id);
      }
    }

    const { app, lines, restore } = await boot({ controllers: [Both] });
    try {
      const response = await app.fetch(new Request('http://localhost/mixed'));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      // The ingress half is ignored: a job enqueued is never consumed.
      const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
      await queue.add('m99d-job', { id: 'job-1' });
      await settle();
      expect(received).toEqual([]);

      const warnings = crossFamily(lines);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]['msg']).toBe(CONTROLLERS_SIDE);
      expect(warnings[0]['controller']).toBe('Both');
      expect(String(warnings[0]['hint'])).toContain('ingress');
    } finally {
      await app.stop();
      restore();
    }
  });

  it('ingress-only: warns naming `controllers`, fires the processor, answers the route 404', async () => {
    const received: string[] = [];
    @Controller('/mixed')
    class Both {
      @Get('/')
      read() {
        return { ok: true };
      }

      @Processor('m99d-job')
      process(job: IJob<{ readonly id: string }>) {
        received.push(job.data.id);
      }
    }

    const { app, lines, restore } = await boot({ ingress: [Both] });
    try {
      // The HTTP half is ignored: the route was never registered.
      const response = await app.fetch(new Request('http://localhost/mixed'));
      expect(response.status).toBe(404);

      // The ingress half fires.
      const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
      await queue.add('m99d-job', { id: 'job-1' });
      await until(() => received.length === 1, 'the decorated queue processor');
      expect(received).toEqual(['job-1']);

      const warnings = crossFamily(lines);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]['msg']).toBe(INGRESS_SIDE);
      expect(warnings[0]['controller']).toBe('Both');
      expect(String(warnings[0]['hint'])).toContain('controllers');
    } finally {
      await app.stop();
      restore();
    }
  });

  it('both lists: no cross-family warning, the route serves and the processor fires', async () => {
    const received: string[] = [];
    @Controller('/mixed')
    class Both {
      @Get('/')
      read() {
        return { ok: true };
      }

      @Processor('m99d-job')
      process(job: IJob<{ readonly id: string }>) {
        received.push(job.data.id);
      }
    }

    const { app, lines, restore } = await boot({ controllers: [Both], ingress: [Both] });
    try {
      const response = await app.fetch(new Request('http://localhost/mixed'));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
      await queue.add('m99d-job', { id: 'job-1' });
      await until(() => received.length === 1, 'the decorated queue processor');
      expect(received).toEqual(['job-1']);

      // Listing a class in BOTH options is the correct composition — both
      // families register — so neither cross-family diagnostic fires.
      expect(crossFamily(lines)).toEqual([]);
    } finally {
      await app.stop();
      restore();
    }
  });

  // The controller list the warning reads is the MERGED one. Reading only the
  // `controllers` option warned "routes are not registered" for a class whose
  // routes a `@Module` had registered, and stayed silent for a module-listed
  // controller whose ingress half was dropped — the generated class-based path.
  it('@Module controllers + ingress: no warning, both families register', async () => {
    const received: string[] = [];
    @Controller('/mixed')
    class Both {
      @Get('/')
      read() {
        return { ok: true };
      }

      @Processor('m99d-job')
      process(job: IJob<{ readonly id: string }>) {
        received.push(job.data.id);
      }
    }
    @Module({ controllers: [Both] })
    class Feature {}

    const { app, lines, restore } = await boot({ modules: [Feature], ingress: [Both] });
    try {
      const response = await app.fetch(new Request('http://localhost/mixed'));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
      await queue.add('m99d-job', { id: 'job-1' });
      await until(() => received.length === 1, 'the decorated queue processor');

      expect(crossFamily(lines)).toEqual([]);
    } finally {
      await app.stop();
      restore();
    }
  });

  it('@Module controllers only: warns that the ingress half is ignored', async () => {
    const received: string[] = [];
    @Controller('/mixed')
    class Both {
      @Get('/')
      read() {
        return { ok: true };
      }

      @Processor('m99d-job')
      process(job: IJob<{ readonly id: string }>) {
        received.push(job.data.id);
      }
    }
    @Module({ controllers: [Both] })
    class Feature {}

    const { app, lines, restore } = await boot({ modules: [Feature] });
    try {
      const response = await app.fetch(new Request('http://localhost/mixed'));
      expect(response.status).toBe(200);

      const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
      await queue.add('m99d-job', { id: 'job-1' });
      await settle();
      expect(received).toEqual([]);

      const warnings = crossFamily(lines);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]['msg']).toBe(CONTROLLERS_SIDE);
      expect(warnings[0]['controller']).toBe('Both');
    } finally {
      await app.stop();
      restore();
    }
  });
});
