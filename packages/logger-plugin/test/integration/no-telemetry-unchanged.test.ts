// deno-lint-ignore-file no-console -- the sink under test IS `console.log`:
// ConsoleLogger writes there (AI_GUIDELINES §11.6), so capturing it is how the
// emitted record is read.
/**
 * M90i — an application with NO telemetry capability emits a byte-identical
 * record.
 *
 * The plugin now ALWAYS installs the trace-enriching decorator, because whether
 * telemetry will be registered cannot be known when the logger registers (the
 * reverse dependency edge is a cycle the resolver refuses). So the
 * compatibility claim every doc site makes — "absent telemetry, behaviour is
 * byte-identical" — is a claim about the DECORATOR BEING INSTALLED AND INERT,
 * and it has to be checked where it is installed.
 *
 * The decorator's own unit suite cannot settle it: it constructs the decorator
 * directly, so it proves the merge is skipped, not that the plugin's registered
 * logger produces the same record an undecorated one does.
 *
 * The check is a real identity comparison against a directly-constructed
 * `ConsoleLogger` — the same transport, the same options, the same message —
 * rather than an assertion that `trace_id` is absent, which would also pass for
 * a decorator that had silently dropped or renamed a caller's own metadata.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger, IRuntimeServices, LogMetadata } from '@setu-ts/common';

import { LoggerPlugin } from '../../src/plugin/logger-plugin.ts';
import { ConsoleLogger } from '../../src/loggers/console-logger.ts';

/** Captures the JSON lines a ConsoleLogger writes. */
function capture(emit: () => void): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  const real = console.log;
  console.log = (line: unknown) => {
    try {
      lines.push(JSON.parse(String(line)) as Record<string, unknown>);
    } catch {
      real(line);
    }
  };
  try {
    emit();
  } finally {
    console.log = real;
  }
  return lines;
}

/** `time` comes from the clock, so it is the one field that legitimately differs. */
function withoutTime(record: Record<string, unknown>): Record<string, unknown> {
  const { time: _time, ...rest } = record;
  return rest;
}

const MESSAGE = 'order created';
const METADATA: LogMetadata = {
  order: 'o-1',
  nested: { tenant: 't-1', count: 3 },
  flag: false,
  missing: null,
};

describe('no telemetry registered — the record is unchanged', () => {
  it('matches a directly-constructed ConsoleLogger field for field', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), LoggerPlugin({ level: 'debug' })],
    });
    await app.start();

    const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    const registered = app.services.get<ILogger>(CAPABILITIES.LOGGER);
    // The same transport the plugin built, undecorated, with the same options.
    const reference = new ConsoleLogger(runtime, { level: 'debug' });

    const [throughPlugin] = capture(() => registered.info(MESSAGE, METADATA));
    const [direct] = capture(() => reference.info(MESSAGE, METADATA));
    await app.stop();

    expect(throughPlugin).toBeDefined();
    expect(direct).toBeDefined();
    // Byte-identical apart from the timestamp — no added key, none dropped, no
    // reordering that would change the serialized line.
    expect(withoutTime(throughPlugin)).toEqual(withoutTime(direct));
    expect(JSON.stringify(withoutTime(throughPlugin)))
      .toBe(JSON.stringify(withoutTime(direct)));
    // And named explicitly, so the intent survives a refactor of the above.
    expect('trace_id' in throughPlugin).toBe(false);
    expect('span_id' in throughPlugin).toBe(false);
  });

  it('matches for a child logger too', async () => {
    // `child()` is decorated as well, so it gets the same guarantee — and the
    // framework's own request logger reaches the logger only this way.
    const app = createApplication({
      plugins: [RuntimePlugin(), LoggerPlugin({ level: 'debug' })],
    });
    await app.start();

    const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    const registered = app.services.get<ILogger>(CAPABILITIES.LOGGER);
    const reference = new ConsoleLogger(runtime, { level: 'debug' });

    const bindings = { requestId: 'r-1' };
    const [throughPlugin] = capture(() => registered.child(bindings).warn(MESSAGE, METADATA));
    const [direct] = capture(() => reference.child(bindings).warn(MESSAGE, METADATA));
    await app.stop();

    expect(JSON.stringify(withoutTime(throughPlugin)))
      .toBe(JSON.stringify(withoutTime(direct)));
    expect(throughPlugin.requestId).toBe('r-1');
  });

  it('keeps redaction working through the decorator', async () => {
    // A configured option whose effect passes THROUGH the decorator: if the
    // wrapper rebuilt metadata rather than forwarding it, redaction would see a
    // different object.
    const app = createApplication({
      plugins: [RuntimePlugin(), LoggerPlugin({ level: 'debug', redact: ['password'] })],
    });
    await app.start();

    const registered = app.services.get<ILogger>(CAPABILITIES.LOGGER);
    const [record] = capture(() => registered.info('login', { password: 'hunter2' }));
    await app.stop();

    expect(record?.password).toBe('[Redacted]');
  });

  it('keeps the noop transport silent', async () => {
    // The decorator must not turn a discarding transport into an emitting one.
    const app = createApplication({
      plugins: [RuntimePlugin(), LoggerPlugin({ transport: 'noop', level: 'debug' })],
    });
    await app.start();

    const registered = app.services.get<ILogger>(CAPABILITIES.LOGGER);
    const lines = capture(() => registered.error('should not appear'));
    await app.stop();

    expect(lines).toHaveLength(0);
  });
});
