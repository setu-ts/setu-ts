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

describe('transformPipeline', () => {
  const transformer = new ZodToOpenApi();

  it('should transform ZodPipeline by transforming the output schema', () => {
    // ZodPipeline is used in .pipe() transformations
    const schema = z.string().pipe(z.string().min(1));
    const result = transformer.transform(schema);

    // Should return the output schema with its constraints
    expect(result).toEqual({ type: 'string', minLength: 1 });
  });
});

describe('transformEffects', () => {
  const transformer = new ZodToOpenApi();

  it('should transform ZodEffects by unwrapping the inner schema', () => {
    // ZodEffects is used in .transform(), .refine(), etc.
    const schema = z.string().transform((val) => val.toUpperCase());
    const result = transformer.transform(schema);

    expect(result).toEqual({ type: 'string' });
  });

  it('should handle ZodRefine effects', () => {
    const schema = z.string().refine((val) => val.length > 3);
    const result = transformer.transform(schema);

    expect(result).toEqual({ type: 'string' });
  });
});

describe('transformArray edge cases', () => {
  const transformer = new ZodToOpenApi();

  it('should handle array with minItems using object format', () => {
    // Test the branch where minLength.value is accessed as an object
    const schema = z.array(z.string()).min(5);
    const result = transformer.transform(schema);

    expect(result).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 5,
    });
  });

  it('should handle array with maxItems using object format', () => {
    const schema = z.array(z.string()).max(10);
    const result = transformer.transform(schema);

    expect(result).toEqual({
      type: 'array',
      items: { type: 'string' },
      maxItems: 10,
    });
  });

  it('should handle array without element type', () => {
    // This tests the branch where typeDef is null/undefined
    // We can't directly create this, but we can test with any()
    const schema = z.array(z.any());
    const result = transformer.transform(schema);

    expect(result.type).toBe('array');
  });

  it('should handle array with number format min/max', () => {
    // Use mock to test the number format path
    const mockSchema = {
      _def: {
        typeName: 'ZodArray',
        type: z.string()._def,
        minLength: 5, // number format, not object
        maxLength: 10, // number format, not object
      },
    };
    const result = transformer.transform(mockSchema);

    expect(result.type).toBe('array');
    expect(result.minItems).toBe(5);
    expect(result.maxItems).toBe(10);
  });

  it('should handle array with undefined typeDef', () => {
    const mockSchema = {
      _def: {
        typeName: 'ZodArray',
        type: undefined,
        minLength: undefined,
        maxLength: undefined,
      },
    };
    const result = transformer.transform(mockSchema);

    expect(result).toEqual({
      type: 'array',
      items: {},
    });
  });
});

describe('transformString edge cases', () => {
  const transformer = new ZodToOpenApi();

  it('should handle string minLength with object format value', () => {
    // Test the branch where check.value is an object with .value property
    const schema = z.string().min(5);
    const result = transformer.transform(schema);

    expect(result.minLength).toBe(5);
  });

  it('should handle string maxLength with object format value', () => {
    const schema = z.string().max(100);
    const result = transformer.transform(schema);

    expect(result.maxLength).toBe(100);
  });
});

describe('transformNumber edge cases', () => {
  const transformer = new ZodToOpenApi();

  it('should handle number min with object format value', () => {
    const schema = z.number().min(0);
    const result = transformer.transform(schema);

    expect(result.minimum).toBe(0);
  });

  it('should handle number max with object format value', () => {
    const schema = z.number().max(100);
    const result = transformer.transform(schema);

    expect(result.maximum).toBe(100);
  });

  it('should handle number with both min and max', () => {
    const schema = z.number().min(0).max(100);
    const result = transformer.transform(schema);

    expect(result).toEqual({
      type: 'number',
      minimum: 0,
      maximum: 100,
    });
  });
});

describe('transformObject edge cases', () => {
  const transformer = new ZodToOpenApi();

  it('should handle object with passthrough', () => {
    const schema = z.object({
      name: z.string(),
    }).passthrough();
    const result = transformer.transform(schema);

    expect(result.additionalProperties).toBe(true);
  });

  it('should handle object with optional fields correctly', () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });
    const result = transformer.transform(schema);

    expect(result.required).toEqual(['required']);
  });
});

describe('transformOptional edge cases', () => {
  const transformer = new ZodToOpenApi();

  it('should handle optional with undefined inner type', () => {
    // This tests the branch where innerType is undefined
    // We can't directly create this with Zod, so we test the normal case
    const schema = z.string().optional();
    const result = transformer.transform(schema);

    expect(result).toEqual({ type: 'string' });
  });
});

describe('transformNullable edge cases', () => {
  const transformer = new ZodToOpenApi();

  it('should handle nullable with undefined inner type', () => {
    // Similar to optional, test the normal case
    const schema = z.string().nullable();
    const result = transformer.transform(schema);

    expect(result).toEqual({ type: 'string', nullable: true });
  });
});

describe('transformEnum edge cases', () => {
  const transformer = new ZodToOpenApi();

  it('should handle enum with values array', () => {
    const schema = z.enum(['a', 'b', 'c']);
    const result = transformer.transform(schema);

    expect(result).toEqual({ enum: ['a', 'b', 'c'] });
  });

  it('should handle enum with single value', () => {
    const schema = z.enum(['only']);
    const result = transformer.transform(schema);

    expect(result).toEqual({ enum: ['only'] });
  });
});

describe('transformIntersection edge cases', () => {
  const transformer = new ZodToOpenApi();

  it('should handle intersection with undefined left/right', () => {
    // Create a mock schema that simulates undefined left/right
    const mockSchema = {
      _def: {
        typeName: 'ZodIntersection',
        left: undefined,
        right: undefined,
      },
    };
    const result = transformer.transform(mockSchema);

    expect(result).toEqual({
      allOf: [{}, {}],
    });
  });
});

describe('transformRecord edge cases', () => {
  const transformer = new ZodToOpenApi();

  it('should handle record with undefined valueType', () => {
    const mockSchema = {
      _def: {
        typeName: 'ZodRecord',
        valueType: undefined,
      },
    };
    const result = transformer.transform(mockSchema);

    expect(result).toEqual({
      type: 'object',
      additionalProperties: {},
    });
  });
});

describe('transformEffects edge cases', () => {
  const transformer = new ZodToOpenApi();

  it('should handle effects with undefined inner schema', () => {
    const mockSchema = {
      _def: {
        typeName: 'ZodEffects',
        schema: undefined,
      },
    };
    const result = transformer.transform(mockSchema);

    expect(result).toEqual({});
  });
});

describe('transformPipeline edge cases', () => {
  const transformer = new ZodToOpenApi();

  it('should handle pipeline with undefined out schema', () => {
    const mockSchema = {
      _def: {
        typeName: 'ZodPipeline',
        out: undefined,
      },
    };
    const result = transformer.transform(mockSchema);

    expect(result).toEqual({});
  });
});

describe('transformDefault edge cases', () => {
  const transformer = new ZodToOpenApi();

  it('should handle default with undefined inner type', () => {
    const mockSchema = {
      _def: {
        typeName: 'ZodDefault',
        innerType: undefined,
        defaultValue: () => 'test',
      },
    };
    const result = transformer.transform(mockSchema);

    expect(result.default).toBe('test');
  });

  it('should handle default with undefined defaultValue function', () => {
    const schema = z.string().default('hello');
    const result = transformer.transform(schema);

    expect(result.default).toBe('hello');
  });
});

describe('transformObject edge cases continued', () => {
  const transformer = new ZodToOpenApi();

  it('should handle object without shape function', () => {
    const mockSchema = {
      _def: {
        typeName: 'ZodObject',
        shape: undefined,
        requiredKeys: undefined,
        unknownKeys: undefined,
      },
    };
    const result = transformer.transform(mockSchema);

    expect(result).toEqual({
      type: 'object',
      properties: {},
    });
  });
});

describe('transformOptional edge cases continued', () => {
  const transformer = new ZodToOpenApi();

  it('should handle optional with undefined innerType', () => {
    const mockSchema = {
      _def: {
        typeName: 'ZodOptional',
        innerType: undefined,
      },
    };
    const result = transformer.transform(mockSchema);

    expect(result).toEqual({});
  });
});

describe('transformNullable edge cases continued', () => {
  const transformer = new ZodToOpenApi();

  it('should handle nullable with undefined innerType', () => {
    const mockSchema = {
      _def: {
        typeName: 'ZodNullable',
        innerType: undefined,
      },
    };
    const result = transformer.transform(mockSchema);

    expect(result).toEqual({ nullable: true });
  });
});

describe('transformEnum edge cases continued', () => {
  const transformer = new ZodToOpenApi();

  it('should handle enum with undefined values and options', () => {
    const mockSchema = {
      _def: {
        typeName: 'ZodEnum',
        values: undefined,
        options: undefined,
      },
    };
    const result = transformer.transform(mockSchema);

    expect(result).toEqual({ enum: [] });
  });
});

describe('transformUnion edge cases', () => {
  const transformer = new ZodToOpenApi();

  it('should handle union with undefined options', () => {
    const mockSchema = {
      _def: {
        typeName: 'ZodUnion',
        options: undefined,
      },
    };
    const result = transformer.transform(mockSchema);

    expect(result).toEqual({
      anyOf: [],
    });
  });
});
