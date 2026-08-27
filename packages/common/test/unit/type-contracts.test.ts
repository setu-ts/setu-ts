/**
 * Compile-time contract tests for `common` type widenings.
 *
 * These assertions are decided by `deno task check` — if a widening is ever
 * narrowed again, this file stops compiling. Runtime expectations are asserted
 * alongside so the file also fails loudly under `deno task test`.
 *
 * M70n / X3-6: `SseMessage.data` accepts every value the frame encoder already
 * documents ("a string is written literally; any non-string is
 * `JSON.stringify`-ed") — notably arrays, primitives and `null`, which the old
 * `string | Record<string, unknown>` union rejected.
 *
 * M74 / X3-8: that union is NARROWED to {@linkcode JsonValue}, so the compiler
 * admits exactly what the encoder can write. The accepted shapes below are
 * unchanged; the rejections are new, and each is pinned with
 * `@ts-expect-error` so an over-wide type stops compiling rather than silently
 * re-admitting a payload `JSON.stringify` throws on.
 *
 * M74 / X3-8: `IWebSocketService.peek` and `ISseService.peek` are REQUIRED
 * members with the committed signatures.
 *
 * M70n / X4-11: `IResponse` carries the REQUIRED `html(body)` member.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  HandlerResult,
  ISseService,
  IWebSocketService,
  JsonValue,
  SseChannel,
  SseMessage,
  WebSocketRoom,
} from '../../src/index.ts';
import type { IResponse } from '../../src/index.ts';

/**
 * A NAMED interface payload. Note the index signature: TypeScript only grants
 * implicit index signatures to object-literal types, never to interfaces, so
 * an interface must carry one to satisfy the union's object arm — before AND
 * after both the M70n widening and the M74 narrowing. What the widening bought
 * is arrays, primitives and `null`, asserted below.
 *
 * M74 changed the index signature it must carry: `Record<string, unknown>`
 * declares `unknown`-valued properties, which are not assignable to
 * `JsonValue | undefined`. This is the migration an application following the
 * pre-M74 documentation performs, so the repository's own fixture performs it
 * as the worked example.
 */
interface NamedSsePayload extends Record<string, JsonValue | undefined> {
  readonly userId: string;
  readonly attemptCount: number;
}

const namedPayload: NamedSsePayload = { userId: 'u-1', attemptCount: 3 };

// Compile-time proof: each widened arm is assignable to `SseMessage.data`.
const withNamedInterface: SseMessage = { data: namedPayload };
const withArray: SseMessage = { data: ['a', 1, true] as const };
const withNumber: SseMessage = { data: 42 };
const withBoolean: SseMessage = { data: false };
const withNull: SseMessage = { data: null };
const withString: SseMessage = { data: 'hello' };

// Compile-time proof: `html` is a REQUIRED member of `IResponse` with the
// committed signature `(body: string) => HandlerResult`.
type HasRequiredHtml = IResponse extends {
  html(body: string): HandlerResult;
} ? true
  : false;
const htmlIsRequiredMember: HasRequiredHtml = true;

describe('SseMessage.data widened union (M70n / X3-6)', () => {
  it('accepts a named-interface payload at compile time', () => {
    expect(withNamedInterface.data).toEqual(namedPayload);
  });

  it('accepts a readonly array payload', () => {
    expect(withArray.data).toEqual(['a', 1, true]);
  });

  it('accepts number, boolean, null, and string payloads', () => {
    expect(withNumber.data).toBe(42);
    expect(withBoolean.data).toBe(false);
    expect(withNull.data).toBeNull();
    expect(withString.data).toBe('hello');
  });
});

// --- M74 / X3-8: JsonValue rejects what JSON.stringify cannot represent ---
// Each directive is self-validating: an UNUSED @ts-expect-error is itself a
// compile error, so an over-wide `data` type fails this file rather than
// silently re-admitting the payload.

// @ts-expect-error a bigint value makes JSON.stringify throw
const rejectsBigint: SseMessage = { data: { balance: 10n } };
// @ts-expect-error a bigint inside an array throws just the same
const rejectsBigintInArray: SseMessage = { data: [1, 10n] };
// @ts-expect-error a function value is silently DROPPED by JSON.stringify
const rejectsFunction: SseMessage = { data: { onDone: (): void => {} } };
// @ts-expect-error a symbol value is silently dropped too
const rejectsSymbol: SseMessage = { data: { tag: Symbol('x') } };
// @ts-expect-error undefined data was already forbidden and stays forbidden
const rejectsUndefined: SseMessage = { data: undefined };

// Accepted: an optional property, and one written out as `T | undefined`.
// JSON.stringify serializes both by dropping the key, so the object arm of
// JsonValue admits `undefined` — see its JSDoc.
type OptionalNote = { readonly build: number; readonly note?: string };
type ExplicitUndefinedNote = { readonly build: number; readonly note: string | undefined };
const withOptionalNote: SseMessage = { data: { build: 412 } satisfies OptionalNote };
const withExplicitUndefined: SseMessage = {
  data: { build: 412, note: undefined } satisfies ExplicitUndefinedNote,
};
const withDeepNesting: SseMessage = {
  data: { a: { b: [1, { c: null }] } },
};

// Accepted BUT normalized: `NaN`, `Infinity` and `-Infinity` are members of
// `number`, which TypeScript cannot subset, and `JSON.stringify` turns each
// into `null` rather than failing. They are pinned here as accepted so the
// documented limit is a checked claim rather than prose — the wire-level
// consequence is asserted in sse-plugin's sse-nonserializable.test.ts.
const withNaN: SseMessage = { data: NaN };
const withInfinity: SseMessage = { data: Infinity };
const withNegativeInfinity: SseMessage = { data: -Infinity };
const withNestedNonFinite: SseMessage = { data: { ratio: NaN, cap: Infinity } };

// --- M74 / X3-8: peek is a REQUIRED member with the committed signature ---
type HasRequiredRoomPeek = IWebSocketService extends {
  peek(name: string): WebSocketRoom | undefined;
} ? true
  : false;
type HasRequiredChannelPeek = ISseService extends {
  peek(name: string): SseChannel | undefined;
} ? true
  : false;
const roomPeekIsRequired: HasRequiredRoomPeek = true;
const channelPeekIsRequired: HasRequiredChannelPeek = true;

describe('SseMessage.data narrowed to JsonValue (M74 / X3-8)', () => {
  it('rejects every value JSON.stringify cannot represent', () => {
    // Decided at compile time by the @ts-expect-error directives above; the
    // runtime assertions keep the file failing loudly under `deno task test`
    // as well as under `deno task check`.
    expect(rejectsBigint).toBeDefined();
    expect(rejectsBigintInArray).toBeDefined();
    expect(rejectsFunction).toBeDefined();
    expect(rejectsSymbol).toBeDefined();
    expect(rejectsUndefined).toBeDefined();
  });

  it('accepts an optional property and an explicit undefined property', () => {
    expect(withOptionalNote.data).toEqual({ build: 412 });
    expect(withExplicitUndefined.data).toEqual({ build: 412, note: undefined });
  });

  it('accepts arbitrary nesting', () => {
    expect(withDeepNesting.data).toEqual({ a: { b: [1, { c: null }] } });
  });

  it('accepts the non-finite numbers, which JSON.stringify normalizes to null', () => {
    // Not a gap in the type — `number` cannot be narrowed to the finite
    // numbers in TypeScript. The point of pinning it is that these are the one
    // category the type admits and JSON does NOT round-trip: they are changed
    // rather than rejected, which the JsonValue JSDoc now states.
    expect(Number.isNaN(withNaN.data)).toBe(true);
    expect(withInfinity.data).toBe(Infinity);
    expect(withNegativeInfinity.data).toBe(-Infinity);

    expect(JSON.stringify(withNaN.data)).toBe('null');
    expect(JSON.stringify(withInfinity.data)).toBe('null');
    expect(JSON.stringify(withNegativeInfinity.data)).toBe('null');
    expect(JSON.stringify(withNestedNonFinite.data)).toBe('{"ratio":null,"cap":null}');
  });

  it('serializes every accepted shape without throwing', () => {
    // The type's whole claim, executed rather than asserted: every value the
    // compiler admits survives the encoder's JSON.stringify.
    for (const msg of [withOptionalNote, withExplicitUndefined, withDeepNesting]) {
      expect(() => JSON.stringify(msg.data)).not.toThrow();
    }
  });
});

describe('peek is a required service member (M74 / X3-8)', () => {
  it('is declared on both realtime services with the committed signature', () => {
    // Decided at compile time by the conditional types above.
    expect(roomPeekIsRequired).toBe(true);
    expect(channelPeekIsRequired).toBe(true);
  });
});

describe('IResponse.html required member (M70n / X4-11)', () => {
  it('is present on the interface with the committed signature', () => {
    // Decided at compile time by the conditional type above.
    expect(htmlIsRequiredMember).toBe(true);
  });
});
