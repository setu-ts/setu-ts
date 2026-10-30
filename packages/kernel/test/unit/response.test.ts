import { describe, expect, it } from 'vitest';
import { ResponseBuilder } from '../../src/context/response.ts';

function isHeaderRecord(headers: HeadersInit): headers is Record<string, string> {
  return !Array.isArray(headers) && !(headers instanceof Headers);
}

describe('ResponseBuilder', () => {
  it('should default status to 200', () => {
    const res = new ResponseBuilder();
    const snap = res.snapshot();
    expect(snap.status).toBe(200);
  });

  it('should chain status and header', () => {
    const res = new ResponseBuilder();
    res.status(201).header('x-test', 'yes');
    const snap = res.snapshot();
    expect(snap.status).toBe(201);
    expect(snap.headers.get('x-test')).toBe('yes');
  });

  it('should set json body and content-type', () => {
    const res = new ResponseBuilder();
    const result = res.json({ ok: true });
    expect(result.__handlerResult).toBe(true);
    const snap = res.snapshot();
    expect(snap.body).toBe('{"ok":true}');
    expect(snap.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.ended).toBe(true);
  });

  it('keeps common terminal headers lazy and isolates native initializer mutation', () => {
    const res = new ResponseBuilder();
    res.json({ ok: true });
    const snapshot = res.snapshot();

    const init = snapshot.responseInit;
    expect(init?.headers).toEqual({
      'content-type': 'application/json; charset=utf-8',
    });
    if (init === undefined || !isHeaderRecord(init.headers)) {
      throw new Error('expected a record header initializer');
    }
    init.headers['content-length'] = '11';

    expect(snapshot.responseInit?.headers).toEqual({
      'content-type': 'application/json; charset=utf-8',
    });
    expect(snapshot.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(snapshot.headers.get('content-length')).toBeNull();
  });

  it('keeps an earlier snapshot headers view live after a later mutation', () => {
    const res = new ResponseBuilder();
    res.json({ ok: true });
    const snapshot = res.snapshot();
    res.header('x-after-snapshot', 'yes');

    expect(snapshot.responseInit).toBeUndefined();
    expect(snapshot.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(snapshot.headers.get('x-after-snapshot')).toBe('yes');
  });

  it('writes a terminal content type through already materialized headers', () => {
    const res = new ResponseBuilder();
    res.header('x-explicit', 'yes').json({ ok: true });

    const snapshot = res.snapshot();
    expect(snapshot.responseInit).toBeUndefined();
    expect(snapshot.headers.get('x-explicit')).toBe('yes');
    expect(snapshot.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  it('materializes headers when terminal methods require different built-in names', () => {
    const res = new ResponseBuilder();
    res.json({ ok: true });
    res.redirect('/next');

    const snapshot = res.snapshot();
    expect(snapshot.responseInit).toBeUndefined();
    expect(snapshot.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(snapshot.headers.get('location')).toBe('/next');
  });

  it('should set text body and content-type', () => {
    const res = new ResponseBuilder();
    res.text('hello');
    const snap = res.snapshot();
    expect(snap.body).toBe('hello');
    expect(snap.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.ended).toBe(true);
  });

  it('should set html body and content-type', () => {
    const res = new ResponseBuilder();
    const result = res.html('<p>hi</p>');
    expect(result.__handlerResult).toBe(true);
    const snap = res.snapshot();
    expect(snap.body).toBe('<p>hi</p>');
    expect(snap.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.ended).toBe(true);
  });

  it('should compose status() with html()', () => {
    const res = new ResponseBuilder();
    res.status(201).html('<p>created</p>');
    const snap = res.snapshot();
    expect(snap.status).toBe(201);
    expect(snap.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('should set raw bytes body with send', () => {
    const res = new ResponseBuilder();
    const bytes = new Uint8Array([1, 2, 3]);
    res.send(bytes);
    const snap = res.snapshot();
    expect(snap.body).toBe(bytes);
    expect(snap.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.ended).toBe(true);
  });

  it('should send empty body with send()', () => {
    const res = new ResponseBuilder();
    res.send();
    const snap = res.snapshot();
    expect(snap.body).toBe(null);
    expect(res.ended).toBe(true);
  });

  it('should not override content-type in send when already set', () => {
    const res = new ResponseBuilder();
    res.header('content-type', 'image/png');
    res.send(new Uint8Array([1]));
    expect(res.snapshot().headers.get('content-type')).toBe('image/png');
  });

  it('should set redirect with default 302', () => {
    const res = new ResponseBuilder();
    res.redirect('https://example.com');
    const snap = res.snapshot();
    expect(snap.status).toBe(302);
    expect(snap.headers.get('location')).toBe('https://example.com');
    expect(snap.body).toBe(null);
    expect(res.ended).toBe(true);
  });

  it('should set redirect with custom status', () => {
    const res = new ResponseBuilder();
    res.redirect('https://example.com', 301);
    expect(res.snapshot().status).toBe(301);
  });

  it('should report ended false before terminal method', () => {
    const res = new ResponseBuilder();
    expect(res.ended).toBe(false);
    res.status(200);
    expect(res.ended).toBe(false);
  });

  it('should preserve multiple appended set-cookie headers', () => {
    const res = new ResponseBuilder();
    res.appendHeader('set-cookie', 'a=1').appendHeader('set-cookie', 'b=2');
    const cookies = res.snapshot().headers.getSetCookie();
    expect(cookies).toEqual(['a=1', 'b=2']);
  });

  it('should overwrite repeated header() calls (set semantics, contrast to append)', () => {
    const res = new ResponseBuilder();
    res.header('set-cookie', 'a=1').header('set-cookie', 'b=2');
    const cookies = res.snapshot().headers.getSetCookie();
    expect(cookies).toEqual(['b=2']);
  });

  it('should return the builder from appendHeader for chaining', () => {
    const res = new ResponseBuilder();
    expect(res.appendHeader('x-test', 'one')).toBe(res);
    expect(res.appendHeader('x-test', 'one').appendHeader('x-test', 'two')).toBe(res);
    expect(res.snapshot().headers.get('x-test')).toBe('one, one, two');
  });

  // M42 — streaming response body
  describe('M42 streaming', () => {
    it('stream() returns HandlerResult brand and sets ended', () => {
      const res = new ResponseBuilder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      });
      const result = res.stream(stream);
      expect(result.__handlerResult).toBe(true);
      expect(res.ended).toBe(true);
    });

    it('snapshot() returns the exact stream with streaming: true', () => {
      const res = new ResponseBuilder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      });
      res.stream(stream);
      const snap = res.snapshot();
      expect(snap.streaming).toBe(true);
      expect(snap.body).toBe(stream);
    });

    it('snapshot() omits the fast init for a stream with no built-in headers', () => {
      const res = new ResponseBuilder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
      res.stream(stream);

      expect(res.snapshot().responseInit).toBeUndefined();
    });

    it('json/text/send/redirect still set streaming: false (regression)', () => {
      const res1 = new ResponseBuilder();
      res1.json({ ok: true });
      expect(res1.snapshot().streaming).toBe(false);

      const res2 = new ResponseBuilder();
      res2.text('hello');
      expect(res2.snapshot().streaming).toBe(false);

      const res3 = new ResponseBuilder();
      res3.send(new Uint8Array([1, 2]));
      expect(res3.snapshot().streaming).toBe(false);

      const res4 = new ResponseBuilder();
      res4.redirect('http://example.com');
      expect(res4.snapshot().streaming).toBe(false);
    });

    it('snapshot() buffered arm returns correct body type', () => {
      const res = new ResponseBuilder();
      res.json({ key: 'value' });
      const snap = res.snapshot();
      expect(snap.streaming).toBe(false);
      expect(snap.body).toBe('{"key":"value"}');
    });
  });
});

/** The headers a response ends with, as sorted pairs, read through the public snapshot. */
function headerPairs(response: ResponseBuilder): [string, string][] {
  const snapshot = response.snapshot();
  const init = snapshot.responseInit?.headers;
  const headers = init !== undefined ? new Headers(init) : snapshot.headers;
  return [...headers.entries()];
}

/** Applies a record the slow way: one header() call per entry. */
function viaHeader(record: Readonly<Record<string, string>>): ResponseBuilder {
  const response = new ResponseBuilder();
  for (const name of Object.keys(record)) response.header(name, record[name]!);
  return response;
}

const SECURITY = { 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };

describe('ResponseBuilder.setHeaders', () => {
  const records: readonly (readonly [string, () => Readonly<Record<string, string>>])[] = [
    ['a frozen plain record (templated)', () => Object.freeze({ ...SECURITY })],
    ['an unfrozen record', () => ({ ...SECURITY })],
    [
      'a frozen null-prototype record (templated)',
      () => Object.freeze(Object.assign(Object.create(null) as Record<string, string>, SECURITY)),
    ],
    [
      'a frozen record with an accessor (never templated)',
      () =>
        Object.freeze(
          Object.defineProperty({ 'X-Frame-Options': 'DENY' }, 'Referrer-Policy', {
            get: () => 'no-referrer',
            enumerable: true,
          }) as Record<string, string>,
        ),
    ],
    [
      'a frozen record with a class prototype (never templated)',
      () => Object.freeze(Object.assign(Object.create({ inherited: 'x' }) as object, SECURITY)),
    ],
  ];

  it.each(records)('sets the same headers as header() per entry for %s', (_label, make) => {
    const record = make();
    for (let round = 0; round < 2; round++) {
      const response = new ResponseBuilder().setHeaders(record) as ResponseBuilder;
      response.json({ ok: true });
      const expected = viaHeader(record);
      expected.json({ ok: true });
      expect(headerPairs(response)).toEqual(headerPairs(expected));
    }
  });

  it('gives every response its own copy of a templated record', () => {
    const record = Object.freeze({ ...SECURITY });
    const first = new ResponseBuilder();
    first.setHeaders(record);
    first.header('x-only-first', '1');
    const second = new ResponseBuilder();
    second.setHeaders(record);
    expect(second.snapshot().headers.has('x-only-first')).toBe(false);
    expect(first.snapshot().headers.get('x-frame-options')).toBe('DENY');
  });

  it('honours an unfrozen record changed between calls', () => {
    const record: Record<string, string> = { 'X-Frame-Options': 'DENY' };
    new ResponseBuilder().setHeaders(record);
    record['X-Frame-Options'] = 'SAMEORIGIN';
    const response = new ResponseBuilder();
    response.setHeaders(record);
    expect(response.snapshot().headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('applies on top of headers already set, and lets later calls override', () => {
    const record = Object.freeze({ ...SECURITY });
    const response = new ResponseBuilder();
    response.header('x-before', '1');
    response.setHeaders(record);
    response.header('x-frame-options', 'SAMEORIGIN');
    response.text('done');
    const headers = response.snapshot().headers;
    expect(headers.get('x-before')).toBe('1');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  it('applies a templated record after a terminal built-in header', () => {
    const response = new ResponseBuilder();
    response.json({});
    response.setHeaders(Object.freeze({ ...SECURITY }));
    expect(response.snapshot().headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.snapshot().headers.get('x-frame-options')).toBe('DENY');
  });

  it.each([
    ['a frozen', true],
    ['an unfrozen', false],
  ] as const)(
    'refuses %s record with an invalid value exactly as header() does',
    (_label, frozen) => {
      const raw = { 'x-ok': 'yes', 'x-bad': 'a\r\nInjected: 1' };
      const record = frozen ? Object.freeze(raw) : raw;
      let viaSetHeaders: unknown;
      const response = new ResponseBuilder();
      try {
        response.setHeaders(record);
      } catch (error) {
        viaSetHeaders = error;
      }
      let viaHeaderCall: unknown;
      const reference = new ResponseBuilder();
      try {
        reference.header('x-ok', 'yes').header('x-bad', 'a\r\nInjected: 1');
      } catch (error) {
        viaHeaderCall = error;
      }
      expect(viaSetHeaders).toBeInstanceOf(TypeError);
      expect((viaSetHeaders as Error).message).toBe((viaHeaderCall as Error).message);
      expect(headerPairs(response)).toEqual(headerPairs(reference));
      // Refused again on a second use: nothing invalid was cached.
      expect(() => new ResponseBuilder().setHeaders(record)).toThrow(TypeError);
    },
  );
});
