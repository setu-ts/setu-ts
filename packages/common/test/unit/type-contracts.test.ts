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
 * M70n / X4-11: `IResponse` carries the REQUIRED `html(body)` member.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { HandlerResult, IResponse, SseMessage } from '../../src/index.ts';

/**
 * A NAMED interface payload. Note the index signature: TypeScript only grants
 * implicit index signatures to object-literal types, never to interfaces, so
 * an interface must carry one to satisfy the union's `Record<string, unknown>`
 * arm — before AND after this widening. What the widening actually buys is
 * arrays, primitives and `null`, asserted below.
 */
interface NamedSsePayload extends Record<string, unknown> {
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

describe('IResponse.html required member (M70n / X4-11)', () => {
  it('is present on the interface with the committed signature', () => {
    // Decided at compile time by the conditional type above.
    expect(htmlIsRequiredMember).toBe(true);
  });
});
