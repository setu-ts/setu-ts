/**
 * Tests for ZodToOpenApi transformer.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { z } from 'npm:zod@^3.24.0';
import { ZodToOpenApi, zodToOpenApi } from '../../src/transformers/zod-to-openapi.ts';

describe('ZodToOpenApi', () => {
  const transformer = new ZodToOpenApi();

  describe('transform', () => {
    it('should transform ZodString to OpenAPI string schema', () => {
      const schema = z.string();
      const result = transformer.transform(schema);

      expect(result).toEqual({ type: 'string' });
    });

    it('should transform ZodString with email format', () => {
      const schema = z.string().email();
      const result = transformer.transform(schema);

      expect(result).toEqual({ type: 'string', format: 'email' });
    });

    it('should transform ZodString with uri format', () => {
      const schema = z.string().url();
      const result = transformer.transform(schema);

      expect(result).toEqual({ type: 'string', format: 'uri' });
    });

    it('should transform ZodString with uuid format', () => {
      const schema = z.string().uuid();
      const result = transformer.transform(schema);

      expect(result).toEqual({ type: 'string', format: 'uuid' });
    });

    it('should transform ZodString with minLength', () => {
      const schema = z.string().min(5);
      const result = transformer.transform(schema);

      expect(result).toEqual({ type: 'string', minLength: 5 });
    });

    it('should transform ZodString with maxLength', () => {
      const schema = z.string().max(100);
      const result = transformer.transform(schema);

      expect(result).toEqual({ type: 'string', maxLength: 100 });
    });

    it('should transform ZodNumber to OpenAPI number schema', () => {
      const schema = z.number();
      const result = transformer.transform(schema);

      expect(result).toEqual({ type: 'number' });
    });

    it('should transform ZodNumber with minimum', () => {
      const schema = z.number().min(0);
      const result = transformer.transform(schema);

      expect(result).toEqual({ type: 'number', minimum: 0 });
    });

    it('should transform ZodNumber with maximum', () => {
      const schema = z.number().max(100);
      const result = transformer.transform(schema);

      expect(result).toEqual({ type: 'number', maximum: 100 });
    });

    it('should transform ZodBoolean to OpenAPI boolean schema', () => {
      const schema = z.boolean();
      const result = transformer.transform(schema);

      expect(result).toEqual({ type: 'boolean' });
    });

    it('should transform ZodBigInt to OpenAPI integer schema', () => {
      const schema = z.bigint();
      const result = transformer.transform(schema);

      expect(result).toEqual({ type: 'integer' });
    });

    it('should transform ZodArray to OpenAPI array schema', () => {
      const schema = z.array(z.string());
      const result = transformer.transform(schema);

      expect(result).toEqual({
        type: 'array',
        items: { type: 'string' },
      });
    });

    it('should transform ZodArray with minItems', () => {
      const schema = z.array(z.string()).min(1);
      const result = transformer.transform(schema);

      expect(result).toEqual({
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
      });
    });

    it('should transform ZodObject to OpenAPI object schema', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });
      const result = transformer.transform(schema);

      expect(result).toEqual({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name', 'age'],
      });
    });

    it('should transform ZodObject with optional fields', () => {
      const schema = z.object({
        name: z.string(),
        email: z.string().optional(),
      });
      const result = transformer.transform(schema);

      expect(result).toEqual({
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['name'],
      });
    });

    it('should transform ZodOptional', () => {
      const schema = z.string().optional();
      const result = transformer.transform(schema);

      expect(result).toEqual({ type: 'string' });
    });

    it('should transform ZodNullable', () => {
      const schema = z.string().nullable();
      const result = transformer.transform(schema);

      expect(result).toEqual({ type: 'string', nullable: true });
    });

    it('should transform ZodEnum', () => {
      const schema = z.enum(['a', 'b', 'c']);
      const result = transformer.transform(schema);

      expect(result).toEqual({ enum: ['a', 'b', 'c'] });
    });

    it('should transform ZodLiteral', () => {
      const schema = z.literal('hello');
      const result = transformer.transform(schema);

      expect(result).toEqual({ const: 'hello' });
    });

    it('should transform ZodUnion', () => {
      const schema = z.union([z.string(), z.number()]);
      const result = transformer.transform(schema);

      expect(result).toEqual({
        anyOf: [{ type: 'string' }, { type: 'number' }],
      });
    });

    it('should transform ZodIntersection', () => {
      const schema = z.intersection(
        z.object({ name: z.string() }),
        z.object({ age: z.number() }),
      );
      const result = transformer.transform(schema);

      expect(result).toEqual({
        allOf: [
          { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
          { type: 'object', properties: { age: { type: 'number' } }, required: ['age'] },
        ],
      });
    });

    it('should transform ZodRecord', () => {
      const schema = z.record(z.string(), z.number());
      const result = transformer.transform(schema);

      expect(result).toEqual({
        type: 'object',
        additionalProperties: { type: 'number' },
      });
    });

    it('should transform ZodDate', () => {
      const schema = z.date();
      const result = transformer.transform(schema);

      expect(result).toEqual({ type: 'string', format: 'date-time' });
    });

    it('should transform ZodEffects by unwrapping', () => {
      const schema = z.string().transform((val) => val.toUpperCase());
      const result = transformer.transform(schema);

      expect(result).toEqual({ type: 'string' });
    });

    it('should transform ZodDefault', () => {
      const schema = z.string().default('hello');
      const result = transformer.transform(schema);

      expect(result).toEqual({ type: 'string', default: 'hello' });
    });

    it('should return empty schema for unknown types', () => {
      const schema = z.any();
      const result = transformer.transform(schema);

      expect(result).toEqual({});
    });

    it('should return empty schema for non-Zod values', () => {
      const result = transformer.transform('not a zod schema');

      expect(result).toEqual({});
    });
  });
});

describe('zodToOpenApi', () => {
  it('should be a convenience wrapper around ZodToOpenApi', () => {
    const schema = z.string();
    const result = zodToOpenApi(schema);

    expect(result).toEqual({ type: 'string' });
  });
});
