# Setu-TS Framework Documentation

Welcome to the Setu-TS framework documentation. This documentation hub provides a complete guide to
building production-ready applications with our plugin-first, runtime-independent framework.

## Quick Start

- **Getting Started**: Learn how to set up your first Setu-TS application
  - [Installation & Setup](./getting-started.md)
  - [First Application](./getting-started.md#your-first-application)
  - [Running on Different Runtimes](./getting-started.md#running-on-different-runtimes)

## Core Concepts

- [Plugin Architecture](./plugin-architecture.md)
  - Understanding the plugin contract
  - Capability tokens and service registration
  - Middleware pipeline
  - Lifecycle hooks

- [Programmatic API](./programmatic-api.md)
  - Application creation and configuration
  - Router and route definitions
  - Request/response handling
  - Service registry

- [Decorators Guide](./decorators.md)
  - Optional decorator support
  - Controller and route decorators
  - Dependency injection
  - Custom decorators

## Tooling

- [CLI Guide](./cli.md)
  - Scaffolding projects: templates, runtimes, `--di`
  - Generating code: the schematics and where each one is wired
  - Domain modules
  - Monorepo workspaces and service discovery

## Plugin Reference

- [Plugin Catalog](./plugins.md)
  - Complete list of all published plugins
  - Runtime compatibility matrix
  - Package links and API references

- [Custom Plugin Development](./custom-plugins.md)
  - Building your own plugins
  - Service registration patterns
  - Testing custom plugins

## Migration Guides

- [Migrating from NestJS](./migration-nestjs.md)
  - Concept mapping
  - Code examples
  - Known differences

- [Migrating from Fastify](./migration-fastify.md)
  - Plugin patterns
  - Hook equivalents
  - Runtime model differences

## Examples

- [Runnable Examples](./examples.md)
  - Minimal application
  - REST API
  - CQRS pattern
  - Multi-tenancy
  - Microservices
  - And more...

## Deployment

- [Runtime Deployment](./runtime-deployment.md)
  - Node.js deployment
  - Deno deployment
  - Bun deployment
  - Cloudflare Workers deployment
  - Streaming and SSE
  - Runtime-specific resources

## API Reference

- [Generated API Documentation](./api/)
  - Full symbol-level reference
  - Generated from source with `deno doc`
  - Rebuild with `deno task docs:api`

## Additional Resources

- [Framework README](../README.md)
  - Project overview
  - Feature matrix
  - Quick links

- [Architecture Guide](../ARCHITECTURE.md)
  - System design
  - Package structure
  - Design decisions

- [Public API Reference](../PUBLIC_API.md)
  - Authoritative public contract
  - Breaking change policy

- [Changelog](../CHANGELOG.md)
  - Version history
  - Migration notes

## Contributing

See the [root README](../README.md) for contribution guidelines.
