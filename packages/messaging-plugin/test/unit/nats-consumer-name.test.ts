// deno-lint-ignore-file no-console -- the guarded real-import case logs a SKIP.
/**
 * Unit tests for the JetStream consumer-name encoding (M101b, V8-6).
 *
 * The forbidden-character table is iterated as DATA, and every encoded output
 * is handed to the REAL nats client's own validator, so the encoder is checked
 * against what the client refuses rather than against a copy of the rule.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  JETSTREAM_FORBIDDEN_NAME_CHARACTERS,
  toJetStreamConsumerName,
} from '../../src/brokers/nats-consumer-name.ts';

/** Expected escape per forbidden character — written out, not computed. */
const EXPECTED_ESCAPES: ReadonlyArray<readonly [string, string]> = [
  ['.', '_2e'],
  ['*', '_2a'],
  ['>', '_3e'],
  ['/', '_2f'],
  ['\\', '_5c'],
  [' ', '_20'],
  ['\t', '_09'],
  ['\n', '_0a'],
  ['\r', '_0d'],
];

/** Dotted and wildcard queues containing no literal escape sequence. */
const CORPUS: readonly string[] = [
  'rr.inbox.6f1c2a',
  'orders.eu',
  'orders.us',
  'orders/eu',
  'orders eu',
  'orders*',
  'orders>',
  'a.b.c',
  'a.b/c',
  'a..b',
  '.leading',
  'trailing.',
  'tab\tname',
  'line\nbreak',
  'carriage\rreturn',
  'back\\slash',
];

describe('toJetStreamConsumerName', () => {
  it('covers exactly the nine characters the nats client refuses', () => {
    expect(EXPECTED_ESCAPES.map(([character]) => character)).toEqual([
      ...JETSTREAM_FORBIDDEN_NAME_CHARACTERS,
    ]);
  });

  for (const [character, escape] of EXPECTED_ESCAPES) {
    it(`escapes ${JSON.stringify(character)} as ${escape}`, () => {
      expect(toJetStreamConsumerName(`a${character}b`)).toBe(`a${escape}b`);
    });
  }

  it('returns a name containing no refused character unchanged', () => {
    for (const legal of ['my-consumer', 'messaging-1234', 'orders_eu', 'Ünïcode-ok', 'x']) {
      expect(toJetStreamConsumerName(legal)).toBe(legal);
    }
  });

  it('encodes the reply inbox address the request path subscribes with', () => {
    expect(toJetStreamConsumerName('rr.inbox.abc')).toBe('rr_2einbox_2eabc');
  });

  it('is injective over queues that contain no literal escape sequence', () => {
    const encoded = CORPUS.map(toJetStreamConsumerName);
    expect(new Set(encoded).size).toBe(CORPUS.length);
  });

  it('is NOT injective for a queue that literally spells an escape (refused by the broker)', () => {
    // The known collision §3.2 refuses rather than escaping `_` and renaming
    // every deployed underscore queue.
    expect(toJetStreamConsumerName('orders.eu')).toBe(toJetStreamConsumerName('orders_2eeu'));
  });

  it('produces names the REAL nats client accepts (guarded real import)', async () => {
    let validateDurableName: (name: string) => string;
    let minValidation: (context: string, name: string) => string;
    try {
      const jsutil = await import('npm:nats@2.x/lib/jetstream/jsutil.js');
      validateDurableName = jsutil.validateDurableName;
      minValidation = jsutil.minValidation;
    } catch {
      console.warn('SKIP: npm:nats is not resolvable');
      return;
    }

    // The real validators REFUSE the raw corpus (positive control: the probe
    // can fail) and accept every encoded output.
    for (const raw of CORPUS) {
      expect(() => validateDurableName(raw)).toThrow('cannot contain');
      const encoded = toJetStreamConsumerName(raw);
      expect(() => validateDurableName(encoded)).not.toThrow();
      expect(() => minValidation('name', encoded)).not.toThrow();
    }
  });
});
