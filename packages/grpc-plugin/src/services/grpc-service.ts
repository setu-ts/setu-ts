/**
 * The gRPC service implementation — applications register services through
 * this class, which is provided under `CAPABILITIES.GRPC` by the plugin.
 *
 * @module
 */

import type { IHttpAdapter } from '@hono-enterprise/common';
import type { RpcFetchHandler } from '@hono-enterprise/common';
import { GrpcUnavailableError } from '../errors/grpc-errors.ts';
import type { ConnectRuntime } from '../interfaces/connect-runtime.ts';
import type { GrpcPluginOptions } from '../interfaces/index.ts';
import { dispatchRequest, normalizeBasePath } from '../transports/rpc-dispatcher.ts';
import { buildConnectRouter } from '../transports/connect-router-builder.ts';
import type { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';

/** Shape of a service definition with a typeName property. */
interface ServiceDefinitionLike {
  typeName?: string;
  methods?: Record<string, unknown>;
}

/**
 * The gRPC service that applications use to register gRPC/Connect services.
 * Implements the {@linkcode IGrpcService} contract from common.
 */
export class GrpcService {
  private readonly services: Array<{
    definition: unknown;
    implementation?: unknown;
  }> = [];

  private readonly basePath: string;
  private readonly connectRuntime: ConnectRuntime;
  private readonly embeddedDescriptors: EmbeddedDescriptors;
  private readonly options: GrpcPluginOptions;

  private dispatchMap: Map<string, (request: Request) => Promise<Response>> | null = null;
  private routerBuilt = false;

  /** Whether the HTTP adapter supports the RPC interceptor seam. */
  readonly available: boolean;

  constructor(
    connectRuntime: ConnectRuntime,
    embeddedDescriptors: EmbeddedDescriptors,
    options: GrpcPluginOptions,
    adapter?: IHttpAdapter,
  ) {
    this.connectRuntime = connectRuntime;
    this.embeddedDescriptors = embeddedDescriptors;
    this.options = options;
    this.basePath = normalizeBasePath(options.basePath ?? '/grpc');
    // Determine if the adapter supports the RPC interceptor seam
    this.available = adapter !== undefined && 'setRpcHandler' in adapter;

    // Pre-register any services provided in options
    if (options.services) {
      for (const { definition, implementation } of options.services) {
        this.addService(definition, implementation);
      }
    }
  }

  addService<TDef>(definition: TDef, _implementation?: unknown): void {
    const defLike = definition as ServiceDefinitionLike;
    const typeName = defLike.typeName;
    if (typeName) {
      const exists = this.services.some(
        (s) => ((s.definition as ServiceDefinitionLike)?.typeName) === typeName,
      );
      if (exists) {
        throw new Error(`Service '${typeName}' has already been registered`);
      }
    }

    this.services.push({ definition, implementation: _implementation });
    this.routerBuilt = false; // Invalidate cached router
  }

  async handleRequest(request: Request): Promise<Response> {
    if (!this.available) {
      throw new GrpcUnavailableError();
    }

    await this.ensureRouter();

    if (!this.dispatchMap) {
      return new Response('No gRPC services configured', { status: 404 });
    }

    const result = await dispatchRequest(request, this.dispatchMap, this.basePath);
    if (result !== null) {
      return result;
    }

    return new Response('Not Found', { status: 404 });
  }

  createFetchHandler(): RpcFetchHandler {
    return async (request: Request): Promise<Response | null> => {
      if (!this.available) {
        return null;
      }

      await this.ensureRouter();

      if (!this.dispatchMap) {
        return null;
      }

      const result = await dispatchRequest(request, this.dispatchMap, this.basePath);
      if (result !== null) {
        return result;
      }

      return null;
    };
  }

  private ensureRouter(): Promise<void> {
    if (this.routerBuilt) {
      return Promise.resolve();
    }

    if (!this.available) {
      this.routerBuilt = true;
      return Promise.resolve();
    }

    const normalizedBase = this.basePath;

    // Build the Connect router with all registered services
    const { dispatchMap } = buildConnectRouter({
      connectRuntime: this.connectRuntime,
      basePath: normalizedBase,
      reflection: this.options.reflection ?? true,
      health: this.options.health ?? true,
      services: this.services,
      embeddedDescriptors: this.embeddedDescriptors,
    });

    this.dispatchMap = dispatchMap;
    this.routerBuilt = true;
    return Promise.resolve();
  }

  // For testing access to internal state
  get servicesCount(): number {
    return this.services.length;
  }

  get dispatchMapSize(): number {
    return this.dispatchMap ? this.dispatchMap.size : 0;
  }
}
