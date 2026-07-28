/**
 * Structural OpenAPI 3.1 subset accepted by the pure SDK generator.
 *
 * These types use the {@code SdkOpenApi*} prefix deliberately to avoid barrel
 * collisions with the openapi-plugin types that share the {@code OpenApi*}
 * prefix but carry different shapes (see plan §1 collision rows).
 *
 * The types are deliberately WIDER than M21's emitted output so every
 * diagnostic in §3.7 is reachable and coverable rather than dead code.
 *
 * @module
 * @since 0.1.0
 */

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/**
 * Top-level OpenAPI 3.1 document consumed by {@code generateOpenApiClient}.
 *
 * @since 0.1.0
 */
export interface SdkOpenApiDocument {
  /** OpenAPI spec version string (expected {@code '3.1.0'}). */
  readonly openapi: string;

  /** API paths keyed by path template. */
  readonly paths: Record<string, SdkOpenApiPathItem>;

  /** Optional component definitions (schemas, parameters, etc.). */
  readonly components?: {
    readonly schemas?: Record<string, SdkOpenApiSchema>;
  };
}

// ---------------------------------------------------------------------------
// Path item
// ---------------------------------------------------------------------------

/**
 * A single path item containing HTTP operation entries.
 *
 * @since 0.1.0
 */
export interface SdkOpenApiPathItem {
  readonly get?: SdkOpenApiOperation;
  readonly put?: SdkOpenApiOperation;
  readonly post?: SdkOpenApiOperation;
  readonly delete?: SdkOpenApiOperation;
  readonly options?: SdkOpenApiOperation;
  readonly head?: SdkOpenApiOperation;
  readonly patch?: SdkOpenApiOperation;
  readonly trace?: SdkOpenApiOperation;
  readonly parameters?: SdkOpenApiParameter[];
}

// ---------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------

/**
 * An HTTP operation (method handler) on a path.
 *
 * {@code operationId} is optional here (wider than M21 which always emits one)
 * so the diagnostic for a missing operationId is reachable in tests.
 *
 * @since 0.1.0
 */
export interface SdkOpenApiOperation {
  readonly operationId?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: string[];
  readonly parameters?: SdkOpenApiParameter[];
  readonly requestBody?: SdkOpenApiRequestBody;
  readonly responses?: Record<string, SdkOpenApiResponse>;
}

// ---------------------------------------------------------------------------
// Parameter
// ---------------------------------------------------------------------------

/**
 * A single operation parameter.
 *
 * {@code in} retains the {@code 'cookie'} arm (M21's type has it) even though
 * M21's generator never emits it, so the unsupported-location diagnostic is
 * reachable and coverable.
 *
 * @since 0.1.0
 */
export interface SdkOpenApiParameter {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header' | 'cookie';
  readonly required?: boolean;
  readonly schema?: SdkOpenApiSchema;
  readonly description?: string;
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

/**
 * Operation request body.
 *
 * @since 0.1.0
 */
export interface SdkOpenApiRequestBody {
  readonly content?: Record<string, SdkOpenApiMediaType>;
  readonly required?: boolean;
  readonly description?: string;
}

/**
 * Media-type entry inside a request body or response.
 *
 * @since 0.1.0
 */
export interface SdkOpenApiMediaType {
  readonly schema?: SdkOpenApiSchema;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * A single response description keyed by status code or range.
 *
 * @since 0.1.0
 */
export interface SdkOpenApiResponse {
  readonly content?: Record<string, SdkOpenApiMediaType>;
  readonly description?: string;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * OpenAPI schema supporting the M21 emitted vocabulary:
 *
 * - Primitive types: {@code string}, {@code number}, {@code integer}, {@code boolean}, {@code null}
 * - Arrays: {@code type: 'array'} with {@code items}
 * - Objects: {@code type: 'object'} with {@code properties}/{@code required}/{@code additionalProperties}
 * - Enums: {@code enum} array of literals
 * - Const: {@code const} single literal
 * - References: {@code $ref}
 * - Unions: {@code anyOf} (used for nullable schemas)
 * - Intersections: {@code allOf}
 * - {@code oneOf} (union, mapped like {@code anyOf})
 * - Empty schema → {@code unknown}
 *
 * @since 0.1.0
 */
export interface SdkOpenApiSchema {
  readonly type?: string | string[];
  readonly $ref?: string;
  readonly properties?: Record<string, SdkOpenApiSchema>;
  readonly required?: string[];
  readonly additionalProperties?: boolean | SdkOpenApiSchema;
  readonly items?: SdkOpenApiSchema;
  readonly enum?: unknown[];
  readonly const?: unknown;
  readonly anyOf?: SdkOpenApiSchema[];
  readonly allOf?: SdkOpenApiSchema[];
  readonly oneOf?: SdkOpenApiSchema[];
  readonly nullable?: boolean;
  readonly description?: string;
  readonly format?: string;
}
