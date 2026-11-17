import { describe, expect, it } from 'vitest';
import { z } from 'zod-v4';
import { validationMetadataOf } from '@setu-ts/common';
import { validateBody, validateQuery } from '../../src/index.ts';
import { ValidationService } from '../../src/services/validation-service.ts';
import { resolveFormatter } from '../../src/formatters/error-formatter.ts';

describe('form validation brands', () => {
  const schema = z.object({ name: z.string() });
  const service = new ValidationService(resolveFormatter('nestjs'));
  it('records the same forms opt-in through helper and service with a non-default formatter', () => {
    for (const middleware of [
      validateBody(schema, { forms: true }),
      service.middleware(schema, 'body', { forms: true }),
    ]) {
      expect(validationMetadataOf(middleware)).toEqual({ target: 'body', schema, forms: true });
    }
  });
  it('omits forms when off or for a non-body target', () => {
    for (const middleware of [
      validateBody(schema),
      validateBody(schema, { forms: false }),
      validateQuery(schema),
      service.middleware(schema, 'body'),
      service.middleware(schema, 'body', { forms: false }),
      service.middleware(schema, 'query', { forms: true }),
    ]) {
      expect(validationMetadataOf(middleware)).not.toHaveProperty('forms');
    }
  });
});
