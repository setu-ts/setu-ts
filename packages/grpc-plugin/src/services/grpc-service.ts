/**
 * The gRPC service implementation — applications register services through
 * this class, which is provided under `CAPABILITIES.GRPC` by the plugin.
 *
 * @module
 */

import type { IHttpAdapter } from '@hono-enterprise/common';
import { RpcFetchHandler } from '@hono-enterprise/common';
import { GrpcUnavailableError } from '../errors/grpc-errors.ts';
import type { ConnectRuntime } from '../interfaces/connect-runtime.ts';
import type { GrpcPluginOptions } from '../interfaces/index.ts';
import { buildDispatcherMap, normalizeBasePath, dispatchRequest } from '../transports/rpc-dispatcher.ts';
import { buildConnectRouter } from '../transports/connect-router-builder.ts';
import { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';

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

  private dispatchMap: Map<string, (request: Request) => Promise<Response>> | null = null;
  private registry: unknown | null = null;
  private routerBuilt = false;

  /** Whether the HTTP adapter supports the RPC interceptor seam. */
  readonly available: boolean;

  constructor(
    connectRuntime: ConnectRuntime,
    embeddedDescriptors: EmbeddedDescriptors,
    options: GrpcPluginOptions,
    adapter: IHttpAdapter | undefined,
    canSetRpcHandler: boolean,
  ) {
    this.connectRuntime = connectRuntime;
    this.embeddedDescriptors = embeddedDescriptors;
    this.basePath = normalizeBasePath(options.basePath ?? '/grpc');
    this.available = canSetRpcHandler;

    // Pre-register any services provided in options
    if (options.services) {
      for (const { definition, implementation } of options.services) {
        this.addService(definition, implementation);
      }
    }
  }

  addService<TDef>(definition: TDef, _implementation?: unknown): void {
    const typeName = (definition as any)?.typeName;
    if (typeName) {
      const exists = this.services.some((s) => (s.definition as any)?.typeName === typeName);
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

  private async ensureRouter(): Promise<void> {
    if (this.routerBuilt) {
      return;
    }

    if (!this.available) {
      this.routerBuilt = true;
      return;
    }

    const normalizedBase = this.basePath;
    
    // Build the Connect router with all registered services
    const { dispatchMap, registry } = buildConnectRouter({
      connectRuntime: this.connectRuntime,
      basePath: normalizedBase,
      reflection: true, // Default to enabled per plan
      health: true,     // Default to enabled per plan
      services: this.services,
      embeddedDescriptors: this.embeddedDescriptors,
    });

    this.dispatchMap = dispatchMap;
    this.registry = registry;
    this.routerBuilt = true;
  }

  // For testing access to internal state
  get servicesCount(): number {
    return this.services.length;
  }

  get dispatchMapSize(): number {
    return this.dispatchMap ? this.dispatchMap.size : 0;
  }
}
