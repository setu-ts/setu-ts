import { GrpcPlugin } from '@setu-ts/grpc-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { connectModule, echoServiceRegistration } from './src/modules/echo/echo.service.ts';

/** Builds an application serving gRPC-family RPC and ordinary HTTP on one port, without starting it. */
export function createApp(): IKernelApplication {
  const app = createApplication({
    plugins: [RuntimePlugin(), GrpcPlugin({ connectModule, services: [echoServiceRegistration] })],
  });

  // An ordinary HTTP route beside the RPC procedures.
  app.router.get('/health', (ctx) => ctx.response.json({ status: 'ok' }));

  return app;
}
