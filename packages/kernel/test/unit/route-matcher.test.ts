import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { match, parsePattern, staticSegmentCount } from '../../src/router/route-matcher.ts';

describe('parsePattern', () => {
  it('should parse static path', () => {
    const segments = parsePattern('/users');
    expect(segments.length).toBe(1);
    expect(segments[0]).toEqual({ type: 'static', value: 'users' });
  });

  it('should parse parameterized path', () => {
    const segments = parsePattern('/users/:id');
    expect(segments[0]).toEqual({ type: 'static', value: 'users' });
    expect(segments[1]).toEqual({ type: 'param', name: 'id' });
  });

  it('should parse root path', () => {
    const segments = parsePattern('/');
    expect(segments.length).toBe(1);
    expect(segments[0]).toEqual({ type: 'static', value: '' });
  });

  it('should handle multiple params', () => {
    const segments = parsePattern('/users/:userId/posts/:postId');
    expect(segments.length).toBe(4);
    expect(segments[1]).toEqual({ type: 'param', name: 'userId' });
    expect(segments[3]).toEqual({ type: 'param', name: 'postId' });
  });
});

describe('match', () => {
  it('should match static path', () => {
    const segments = parsePattern('/users');
    const params = match(segments, '/users');
    expect(params).toEqual({});
  });

  it('should match parameterized path and extract params', () => {
    const segments = parsePattern('/users/:id');
    const params = match(segments, '/users/123');
    expect(params).toEqual({ id: '123' });
  });

  it('should return null for non-matching path', () => {
    const segments = parsePattern('/users');
    const params = match(segments, '/posts');
    expect(params).toBe(null);
  });

  it('should return null for different segment count', () => {
    const segments = parsePattern('/users/:id');
    const params = match(segments, '/users/123/comments');
    expect(params).toBe(null);
  });

  it('should decode URI components in params', () => {
    const segments = parsePattern('/files/:name');
    const params = match(segments, '/files/hello%20world');
    expect(params).toEqual({ name: 'hello world' });
  });

  it('should normalize trailing slashes', () => {
    const segments = parsePattern('/users');
    const params = match(segments, '/users/');
    expect(params).toEqual({});
  });

  it('should match root path', () => {
    const segments = parsePattern('/');
    const params = match(segments, '/');
    expect(params).toEqual({});
  });

  it('should not match root against non-root', () => {
    const segments = parsePattern('/');
    const params = match(segments, '/users');
    expect(params).toBe(null);
  });
});

describe('staticSegmentCount', () => {
  it('should count static segments', () => {
    const segments = parsePattern('/users/:id/posts/:postId');
    expect(staticSegmentCount(segments)).toBe(2);
  });

  it('should return 0 for all params', () => {
    const segments = parsePattern('/:a/:b');
    expect(staticSegmentCount(segments)).toBe(0);
  });
});
