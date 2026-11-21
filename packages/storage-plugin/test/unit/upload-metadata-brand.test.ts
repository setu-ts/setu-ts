/**
 * `createUploadMiddleware` brands its middleware with what it accepts, so the
 * OpenAPI generator can document the route's multipart body (V13-58, the
 * storage half).
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { uploadMetadataOf } from '@setu-ts/common';
import { createUploadMiddleware } from '../../src/middleware/upload-middleware.ts';

describe('createUploadMiddleware upload brand (V13-58)', () => {
  it('records the field, the size bound, the count and the types', () => {
    const middleware = createUploadMiddleware({
      fieldname: 'avatar',
      maxSize: 2048,
      maxFiles: 1,
      allowedMimeTypes: ['image/png', 'image/jpeg'],
    });
    expect(uploadMetadataOf(middleware)).toEqual({
      fieldname: 'avatar',
      maxBytes: 2048,
      maxFiles: 1,
      mimeTypes: ['image/png', 'image/jpeg'],
    });
  });

  it('records the defaults and omits what was not set', () => {
    const metadata = uploadMetadataOf(createUploadMiddleware());
    expect(metadata?.fieldname).toBe('file');
    expect(metadata?.maxBytes).toBeGreaterThan(0);
    expect(metadata).not.toHaveProperty('maxFiles');
    expect(metadata).not.toHaveProperty('mimeTypes');
  });
});
