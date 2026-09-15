// deno-lint-ignore-file no-console -- guarded skip tests log SKIP messages.
/**
 * Real Service Bus outage gate (M95b §3.3) — the 2×2 the letter was opened
 * for. Against this emulator the management probe resolves `undefined` in
 * BOTH states (no TLS listener for administration), so `0.6.0` answered
 * `up`/200 whether the broker was running or stopped and the indicator
 * discriminated in neither state. The data-plane evidence window (§3.2) is
 * what carries the signal here, which is why the publishes are LOAD-BEARING
 * rather than setup: a poll-only variant cannot pass its own stopped cell.
 *
 * The sequence this suite asserts is the `0.6.0` row of the §0 table — `up`
 * while running, `down` while stopped, `up` again after restart — plus the
 * assertion that the running and stopped answers DIFFER, which is the one
 * thing neither shipped version had. Each health answer is preceded by the
 * publish §3.2 reads: a successful publish before the first `up`, a
 * rejected publish against the stopped emulator before the `down`, and
 * another successful publish after restart. The broker is constructed with
 * `retryOptions: { maxRetries: 0 }` (the M90b escape hatch) so the stopped
 * publish rejects inside the test budget instead of consuming the SDK's
 * default retry schedule.
 *
 * Guarded on `SERVICEBUS_CONNECTION_STRING` (no underscore between SERVICE
 * and BUS — the TEST guard variable the documented emulator command sets;
 * `SERVICE_BUS_CONNECTION_STRING` is the DEPLOYMENT variable and using it
 * here would make the suite skip under the documented command). Local-only
 * by decision (§3.4): the emulator is not repeatable against a persistent
 * container and the image is large; `test/apps-gate.test.ts` records that
 * absence as deliberate. The suite restarts the container itself and leaves
 * it running, so a second run works.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ServiceBusBroker } from '../../src/brokers/service-bus-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';

const connectionString = Deno.env.get('SERVICEBUS_CONNECTION_STRING');
const skipReal = connectionString === undefined;

async function docker(args: string[]): Promise<string> {
  const out = await new Deno.Command('docker', { args }).output();
  if (!out.success) {
    throw new Error(
      `docker ${args.join(' ')} failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return new TextDecoder().decode(out.stdout);
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('REAL Service Bus outage (M95b §3.3)', {
  ignore: skipReal,
}, () => {
  it('the 2×2: publish → up, stop → publish rejects → down, restart → publish → up — and the answers differ', async () => {
    const cs = connectionString ?? '';

    // he-sb is the emulator container the documented run command names; its
    // AMQP port is published on 5673 (5672 is RabbitMQ's).
    const containerId = (await docker(['ps', '-q', '--filter', 'name=he-sb'])).trim();
    expect(containerId).not.toBe('');

    const broker = new ServiceBusBroker(
      {
        platform: () => 'deno' as const,
        version: () => 'test',
        hrtime: () => performance.now(),
        now: () => Date.now(),
        uuid: () => crypto.randomUUID(),
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: (h: unknown) => clearTimeout(h as number),
        setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
        clearInterval: (h: unknown) => clearInterval(h as number),
      } as ConstructorParameters<typeof ServiceBusBroker>[0],
      new JsonSerializer(),
      {
        connectionString: cs,
        retryOptions: { maxRetries: 0 },
      },
    );

    try {
      await broker.connect();

      // (running) a successful publish IS the data-plane evidence: with the
      // management probe resolving `undefined` against this emulator in
      // every state, only the recorded success can answer `up`.
      await broker.publish('orders-roundtrip', { phase: 'running' });
      const runningAnswer = await broker.reachability();
      expect(runningAnswer).toBe(true);

      // (stopped) a real stop. The publish against the dead namespace is
      // awaited to its rejection — a status-less network failure, exactly
      // the shape the evidence predicate records — and THAT rejection is
      // what makes the indicator say `down`.
      await docker(['stop', containerId]);
      await wait(1_000); // let the stop settle
      let stoppedError: unknown = undefined;
      try {
        await broker.publish('orders-roundtrip', { phase: 'stopped' });
      } catch (error) {
        stoppedError = error;
      }
      expect(stoppedError).toBeDefined();
      const stoppedAnswer = await broker.reachability();
      expect(stoppedAnswer).toBe(false);

      // The discriminator neither 0.5.0 nor 0.6.0 had: the two states get
      // DIFFERENT answers through the same indicator path.
      expect(runningAnswer).not.toBe(stoppedAnswer);

      // (restart) the container returns; a successful publish re-records
      // evidence and the answer returns to `up`.
      await docker(['start', containerId]);
      let reconnected = false;
      for (let i = 0; i < 60 && !reconnected; i++) {
        await wait(1_000);
        try {
          await broker.publish('orders-roundtrip', { phase: 'recovered' });
          reconnected = true;
        } catch {
          // The emulator is still coming up; retry.
        }
      }
      expect(reconnected).toBe(true);
      expect(await broker.reachability()).toBe(true);
    } finally {
      // Leave the container RUNNING: R11 records that a second consecutive
      // run against a stopped or dirty emulator fails for reasons unrelated
      // to the change.
      await new Deno.Command('docker', { args: ['start', containerId] }).output();
      await broker.disconnect().catch(() => {});
    }
  });
});
