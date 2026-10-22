import type { IKernelApplication } from '@setu-ts/kernel';
import { createRestApp } from '@setu-ts/rest-starter';
import { DEMO_JWT_SECRET } from './src/auth/demo-token.ts';
import { registerModules } from './src/modules/index.ts';

/** Builds the todo API on the REST starter, without starting it. */
export function createApp(): IKernelApplication {
  const app = createRestApp({
    auth: {
      jwt: { secret: DEMO_JWT_SECRET },
      rbac: { roles: {} },
    },
    openapi: {
      title: 'Todo API',
      version: '1.0.0',
      // The security scheme is what gives Swagger UI its Authorize button.
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      security: [{ bearerAuth: [] }],
      // Probe and metrics endpoints are operational, not part of the todo API.
      exclude: ['/health', '/live', '/ready', '/metrics'],
    },
  });

  registerModules(app.router);

  return app;
}
