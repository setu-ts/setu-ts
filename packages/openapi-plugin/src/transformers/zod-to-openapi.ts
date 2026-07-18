/**
 * Zod to OpenAPI 3.1 schema transformer.
 *
 * @module
 */

/**
 * OpenAPI 3.1 schema object.
 *
 * @since 0.1.0
 */
export interface OpenApiSchemaObject {
  /** Type of the value (string, number, integer, boolean, array, object). */
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  /** Format (e.g., 'email', 'uri', 'uuid', 'date-time'). */
  format?: string;
  /** For arrays: schema of items. */
  items?: OpenApiSchemaObject;
  /** For objects: properties map. */
  properties?: Record<string, OpenApiSchemaObject>;
  /** For objects: required property names. */
  required?: readonly string[];
  /** For objects: additional properties schema. */
  additionalProperties?: boolean | OpenApiSchemaObject;
  /** For strings: minimum length. */
  minLength?: number;
  /** For strings: maximum length. */
  maxLength?: number;
  /** For numbers: minimum value. */
  minimum?: number;
  /** For numbers: maximum value. */
  maximum?: number;
  /** For numbers: exclusive minimum. */
  exclusiveMinimum?: number;
  /** For numbers: exclusive maximum. */
  exclusiveMaximum?: number;
  /** For arrays: minimum items. */
  minItems?: number;
  /** For arrays: maximum items. */
  maxItems?: number;
  /** Enum values. */
  enum?: readonly (string | number | boolean)[];
  /** Const value. */
  const?: string | number | boolean;
  /** AnyOf for unions. */
  anyOf?: readonly OpenApiSchemaObject[];
  /** AllOf for intersections. */
  allOf?: readonly OpenApiSchemaObject[];
  /** Nullable flag. */
  nullable?: boolean;
  /** Default value. */
  default?: unknown;
  /** Reference to a component schema. */
  $ref?: string;
}

type ZodDef = {
  typeName: string;
  [key: string]: unknown;
};

type ZodSchema = {
  _def: ZodDef;
  [key: string]: unknown;
};

/**
 * Converts a Zod schema to an OpenAPI 3.1 schema object.
 *
 * @since 0.1.0
 */
export class ZodToOpenApi {
  /**
   * Transforms a Zod schema into an OpenAPI schema object.
   *
   * @param schema - The Zod schema to convert (unknown to accept any Zod schema)
   * @returns The OpenAPI schema object representation
   */
  transform(schema: unknown): OpenApiSchemaObject {
    const zodSchema = schema as ZodSchema | undefined;

    // Check if it's a Zod schema by looking for _def
    if (!zodSchema?._def) {
      // Not a Zod schema, return empty schema
      return {};
    }

    const def = zodSchema._def;
    const typeName = def.typeName;

    switch (typeName) {
      case 'ZodString':
        return this.transformString(zodSchema, def);
      case 'ZodNumber':
        return this.transformNumber(zodSchema, def);
      case 'ZodBoolean':
        return { type: 'boolean' };
      case 'ZodBigInt':
        return { type: 'integer' };
      case 'ZodArray':
        return this.transformArray(zodSchema, def);
      case 'ZodObject':
        return this.transformObject(zodSchema, def);
      case 'ZodOptional':
        return this.transformOptional(zodSchema, def);
      case 'ZodNullable':
        return this.transformNullable(zodSchema, def);
      case 'ZodEnum':
        return this.transformEnum(def);
      case 'ZodLiteral':
        return this.transformLiteral(def);
      case 'ZodUnion':
        return this.transformUnion(zodSchema, def);
      case 'ZodIntersection':
        return this.transformIntersection(zodSchema, def);
      case 'ZodRecord':
        return this.transformRecord(zodSchema, def);
      case 'ZodDate':
        return { type: 'string', format: 'date-time' };
      case 'ZodEffects':
        return this.transformEffects(zodSchema, def);
      case 'ZodPipeline':
        return this.transformPipeline(zodSchema, def);
      case 'ZodDefault':
        return this.transformDefault(zodSchema, def);
      default:
        // Unknown Zod type, return empty schema (graceful degradation)
        return {};
    }
  }

  private transformString(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const schema: OpenApiSchemaObject = { type: 'string' };
    // Zod uses 'kind' for the check type, not 'type'
    const checks = def.checks as
      | readonly { kind: string; value?: number | { value: number }; exact?: boolean }[]
      | undefined;

    if (checks) {
      for (const check of checks) {
        if (check.kind === 'email') {
          schema.format = 'email';
        } else if (check.kind === 'uri' || check.kind === 'url') {
          schema.format = 'uri';
        } else if (check.kind === 'uuid') {
          schema.format = 'uuid';
        } else if (check.kind === 'min') {
          // Zod 3.x stores min/max value as { value: number, message: string } or plain number
          const checkValue = check.value;
          const val = typeof checkValue === 'number'
            ? checkValue
            : (checkValue && typeof checkValue === 'object' && 'value' in checkValue)
            ? (checkValue as { value: number }).value
            : undefined;
          if (typeof val === 'number') schema.minLength = val;
        } else if (check.kind === 'max') {
          const checkValue = check.value;
          const val = typeof checkValue === 'number'
            ? checkValue
            : (checkValue && typeof checkValue === 'object' && 'value' in checkValue)
            ? (checkValue as { value: number }).value
            : undefined;
          if (typeof val === 'number') schema.maxLength = val;
        }
      }
    }

    return schema;
  }

  private transformNumber(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const schema: OpenApiSchemaObject = { type: 'number' };
    // Zod uses 'kind' for the check type, not 'type'
    const checks = def.checks as
      | readonly {
        kind: string;
        value?: number | { value: number; message: string };
        inclusive?: boolean;
      }[]
      | undefined;

    if (checks) {
      for (const check of checks) {
        const checkValue = check.value;
        const val = typeof checkValue === 'number'
          ? checkValue
          : (checkValue && typeof checkValue === 'object' && 'value' in checkValue)
          ? (checkValue as { value: number }).value
          : undefined;

        if (check.kind === 'min' && typeof val === 'number') {
          schema.minimum = val;
        } else if (check.kind === 'max' && typeof val === 'number') {
          schema.maximum = val;
        }
      }
    }

    return schema;
  }

  private transformArray(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const typeDef = def.type as ZodSchema | undefined;
    const schema: OpenApiSchemaObject = {
      type: 'array',
      items: typeDef ? this.transform(typeDef) : {},
    };

    // ZodArray stores min/max as { value: number, message: string } or just number or null
    const minLength = def.minLength as { value?: number } | number | null | undefined;
    const maxLength = def.maxLength as { value?: number } | number | null | undefined;

    const minVal = (minLength && typeof minLength === 'object' && minLength.value !== undefined)
      ? minLength.value
      : (typeof minLength === 'number' ? minLength : undefined);
    const maxVal = (maxLength && typeof maxLength === 'object' && maxLength.value !== undefined)
      ? maxLength.value
      : (typeof maxLength === 'number' ? maxLength : undefined);

    if (typeof minVal === 'number') {
      schema.minItems = minVal;
    }
    if (typeof maxVal === 'number') {
      schema.maxItems = maxVal;
    }

    return schema;
  }

  private transformObject(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const shapeFn = def.shape as (() => Record<string, ZodSchema>) | undefined;
    const shape = typeof shapeFn === 'function' ? shapeFn() : {};
    const properties: Record<string, OpenApiSchemaObject> = {};
    const required: string[] = [];
    const requiredKeys = def.requiredKeys as Set<string> | undefined;

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = this.transform(value);

      const isOptional = (value._def?.typeName as string | undefined) === 'ZodOptional';
      if (!isOptional && requiredKeys?.has(key)) {
        required.push(key);
      } else if (!isOptional && !requiredKeys?.has(key)) {
        required.push(key);
      }
    }

    const schema: OpenApiSchemaObject = {
      type: 'object',
      properties,
    };

    if (required.length > 0) {
      schema.required = required;
    }

    const unknownKeys = def.unknownKeys as string | undefined;
    if (unknownKeys === 'passthrough') {
      schema.additionalProperties = true;
    }

    return schema;
  }

  private transformOptional(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const innerType = def.innerType as ZodSchema | undefined;
    return innerType ? this.transform(innerType) : {};
  }

  private transformNullable(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const innerType = def.innerType as ZodSchema | undefined;
    const innerSchema = innerType ? this.transform(innerType) : {};
    return { ...innerSchema, nullable: true };
  }

  private transformEnum(def: ZodDef): OpenApiSchemaObject {
    // ZodEnum stores values in def.values (array)
    const values = def.values as readonly string[] | undefined;

    if (values && Array.isArray(values)) {
      return { enum: [...values] };
    }

    // Fallback: try def.options
    const options = def.options as readonly string[] | undefined;
    if (options && Array.isArray(options)) {
      return { enum: [...options] };
    }

    return { enum: [] };
  }

  private transformLiteral(def: ZodDef): OpenApiSchemaObject {
    const value = def.value as string | number | boolean;
    return { const: value };
  }

  private transformUnion(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const options = def.options as readonly ZodSchema[] | undefined;
    return {
      anyOf: options ? options.map((option) => this.transform(option)) : [],
    };
  }

  private transformIntersection(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const left = def.left as ZodSchema | undefined;
    const right = def.right as ZodSchema | undefined;
    return {
      allOf: [
        left ? this.transform(left) : {},
        right ? this.transform(right) : {},
      ],
    };
  }

  private transformRecord(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const valueType = def.valueType as ZodSchema | undefined;
    return {
      type: 'object',
      additionalProperties: valueType ? this.transform(valueType) : {},
    };
  }

  private transformEffects(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const innerSchema = def.schema as ZodSchema | undefined;
    return innerSchema ? this.transform(innerSchema) : {};
  }

  private transformPipeline(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const outSchema = def.out as ZodSchema | undefined;
    return outSchema ? this.transform(outSchema) : {};
  }

  private transformDefault(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const innerType = def.innerType as ZodSchema | undefined;
    const defaultValue = def.defaultValue as (() => unknown) | undefined;
    const schema = innerType ? this.transform(innerType) : {};
    if (defaultValue) {
      try {
        schema.default = defaultValue();
      } catch {
        // Ignore errors getting default value
      }
    }
    return schema;
  }
}

/**
 * Convenience function for one-off Zod to OpenAPI conversion.
 *
 * @param schema - The Zod schema to convert
 * @returns The OpenAPI schema object
 * @since 0.1.0
 */
export function zodToOpenApi(schema: unknown): OpenApiSchemaObject {
  return new ZodToOpenApi().transform(schema);
}
