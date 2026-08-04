import { CAPABILITIES } from '@hono-enterprise/common';
import type { IMessageBroker, IServiceDiscovery } from '@hono-enterprise/common';
import { createApplication } from '@hono-enterprise/kernel';
import type { IKernelApplication } from '@hono-enterprise/kernel';
import { MessagingPlugin } from '@hono-enterprise/messaging-plugin';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { ServiceDiscoveryPlugin } from '@hono-enterprise/service-discovery-plugin';

/** Builds service B with a network endpoint that service A reaches through discovery. */
export function createServiceB(): IKernelApplication {
  const app = createApplication({ plugins: [RuntimePlugin()] });
  app.router.get(
    '/hello',
    (ctx) => ctx.response.json({ greeting: 'Hello, service-a!' }),
  );
  return app;
}

/** Builds service A with a static route to service B and an in-memory RPC broker. */
export function createServiceA(serviceBPort: number): IKernelApplication {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      MessagingPlugin(),
      ServiceDiscoveryPlugin({
        provider: 'static',
        services: { 'service-b': [{ host: '127.0.0.1', port: serviceBPort }] },
      }),
    ],
  });
}

/** Resolves service B then calls its independent HTTP endpoint. */
export async function callServiceB(app: IKernelApplication): Promise<string> {
  const discovery = app.services.get<IServiceDiscovery>(
    CAPABILITIES.SERVICE_DISCOVERY,
  );
  const url = await discovery.resolveUrl('service-b', '/hello');
  if (url === null) throw new Error('Service discovery did not resolve service B.');
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Service B returned ${response.status} at ${url}.`);
  }
  const body = await response.json() as { greeting?: string };
  if (body.greeting === undefined) {
    throw new Error('Service B returned no greeting.');
  }
  return body.greeting;
}

/** Exercises the messaging plugin's brokered request/reply surface. */
export async function brokeredGreeting(
  app: IKernelApplication,
): Promise<string> {
  const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
  const subscription = await broker.respond<
    { readonly name: string },
    { readonly greeting: string }
  >(
    'service-b.greet',
    (request) => ({ greeting: `Hello, ${request.name}!` }),
  );
  try {
    const reply = await broker.request<
      { readonly name: string },
      { readonly greeting: string }
    >(
      'service-b.greet',
      { name: 'service-a' },
    );
    return reply.greeting;
  } finally {
    await subscription.unsubscribe();
  }
}
