/**
 * @module
 *
 * Optional decorator and metadata system plugin.
 *
 * Provides NestJS-style decorators (`@Controller`, `@Get`, `@Body`, …) as
 * syntactic sugar over the kernel's programmatic API. Decorators capture
 * metadata in a plain {@linkcode MetadataStore}; the `DecoratorPlugin` reads
 * that store at registration time and registers routes, services, and
 * middleware with the kernel. No reflection (`reflect-metadata`) is required,
 * and decorators are inert unless the `DecoratorPlugin` is registered.
 *
 * Every export here is public API and documented in PUBLIC_API.md
 * (AI_GUIDELINES §10).
 */

// --- Metadata store ---
export { MetadataStore, metadataStore } from './metadata/metadata-store.ts';
export type { ParameterMetadata, ParameterType } from './metadata/metadata-store.ts';

// --- Controller decorators ---
export { Controller, Version } from './decorators/controller.ts';

// --- HTTP method decorators ---
export { Delete, Get, Head, Options, Patch, Post, Put } from './decorators/http.ts';
export type { HttpMethodDecorator } from './decorators/http.ts';

// --- Request parameter decorators ---
export { Body, Cookie, Header, Param, Query } from './decorators/request.ts';

// --- Injection decorators ---
export { Inject, Injectable } from './decorators/injection.ts';
export type { InjectableOptions } from './decorators/injection.ts';

// --- Security decorators ---
export { CurrentUser, Permissions, Public, Roles } from './decorators/security.ts';

// --- Pipeline decorators ---
export { UseFilters, UseGuards, UseInterceptors } from './decorators/pipeline.ts';
export type { MiddlewareLike } from './decorators/pipeline.ts';

// --- Validation decorators ---
export { ValidateBody, ValidateParams, ValidateQuery } from './decorators/validation.ts';

// --- OpenAPI decorators ---
export { ApiOperation, ApiResponse, ApiTags } from './decorators/openapi.ts';
export type { ApiOperationConfig, ApiResponseConfig } from './decorators/openapi.ts';

// --- Custom decorator factories ---
export { createDecorator, createParameterDecorator } from './decorators/custom.ts';

// --- Parameter resolver ---
export {
  clearParameterResolvers,
  getParameterResolver,
  parseCookies,
  registerParameterResolver,
  resolveParameter,
  resolveParameters,
} from './resolvers/parameter-resolver.ts';
export type { CustomParameterResolver } from './resolvers/parameter-resolver.ts';

// --- Controller discovery ---
export { discoverControllers } from './discovery/controller-discovery.ts';
export type {
  DiscoveryOptions,
  DiscoveryResult,
  ModuleImporter,
} from './discovery/controller-discovery.ts';

// --- Plugin factory ---
export { DecoratorPlugin } from './plugin/decorator-plugin.ts';
export type { DecoratorPluginOptions } from './plugin/decorator-plugin.ts';
