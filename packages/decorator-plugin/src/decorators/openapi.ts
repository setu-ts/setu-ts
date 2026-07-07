/**
 * OpenAPI decorators — contribute OpenAPI specification metadata to routes.
 *
 * The metadata is stored for consumption by the OpenAPIPlugin; this plugin
 * does not call `ctx.openapi` directly.
 *
 * @module
 */
import type { Constructor } from '@hono-enterprise/common';

import { metadataStore } from '../metadata/metadata-store.ts';
import { protoToCtor } from '../internal.ts';

/**
 * Configuration for {@linkcode ApiOperation}.
 *
 * @since 0.1.0
 */
export interface ApiOperationConfig {
  /** Operation id. */
  readonly operationId?: string;
  /** Short summary. */
  readonly summary?: string;
  /** Longer description. */
  readonly description?: string;
}

/**
 * Configuration for {@linkcode ApiResponse}.
 *
 * @since 0.1.0
 */
export interface ApiResponseConfig {
  /** HTTP status code. */
  readonly status: number;
  /** Response description. */
  readonly description?: string;
  /** Response body schema. */
  readonly schema?: unknown;
}

/**
 * Assigns OpenAPI tags to a controller. Tags are inherited by every route in
 * the controller and merged with any method-level tags.
 *
 * @param tags - One or more tag names
 * @returns A class decorator
 * @since 0.1.0
 */
export function ApiTags(...tags: string[]): ClassDecorator {
  return (target) => {
    metadataStore.mergeController(target as unknown as Constructor, { tags });
    return target;
  };
}

/**
 * Describes the OpenAPI operation for a route handler.
 *
 * @param config - Operation id, summary, and/or description
 * @returns A method decorator
 * @since 0.1.0
 */
export function ApiOperation(config: ApiOperationConfig): MethodDecorator {
  return (target, propertyKey) => {
    metadataStore.mutateMethod(protoToCtor(target), String(propertyKey), (meta) => {
      if (meta.openapi === undefined) {
        meta.openapi = {};
      }
      const oa = meta.openapi;
      if (config.operationId !== undefined) {
        oa.operationId = config.operationId;
      }
      if (config.summary !== undefined) {
        oa.summary = config.summary;
      }
      if (config.description !== undefined) {
        oa.description = config.description;
      }
    });
  };
}

/**
 * Documents a response status for a route handler. May be applied multiple
 * times to describe several responses.
 *
 * @param config - Status code, optional description and schema
 * @returns A method decorator
 * @since 0.1.0
 */
export function ApiResponse(config: ApiResponseConfig): MethodDecorator {
  return (target, propertyKey) => {
    metadataStore.mutateMethod(protoToCtor(target), String(propertyKey), (meta) => {
      if (meta.openapi === undefined) {
        meta.openapi = {};
      }
      if (meta.openapi.responses === undefined) {
        meta.openapi.responses = {};
      }
      meta.openapi.responses[String(config.status)] = {
        ...(config.description !== undefined ? { description: config.description } : {}),
        ...(config.schema !== undefined ? { schema: config.schema } : {}),
      };
    });
  };
}
