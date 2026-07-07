import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ResponseBuilder } from '../../src/context/response.ts';

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

  it('should set text body and content-type', () => {
    const res = new ResponseBuilder();
    res.text('hello');
    const snap = res.snapshot();
    expect(snap.body).toBe('hello');
    expect(snap.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.ended).toBe(true);
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
});
