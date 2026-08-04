import { CAPABILITIES } from '@hono-enterprise/common';
import type { IMessageBroker, IServiceDiscovery } from '@hono-enterprise/common';
import { createApplication } from '@hono-enterprise/kernel';
import type { IKernelApplication } from '@hono-enterprise/kernel';
import { MessagingPlugin } from '@hono-enterprise/messaging-plugin';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { ServiceDiscoveryPlugin } from '@hono-enterprise/service-discovery-plugin';

/** Builds service A with a static route to service B and an in-memory RPC broker. */
export function createServiceA(): IKernelApplication {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      MessagingPlugin(),
      ServiceDiscoveryPlugin({
        provider: 'static',
        services: { 'service-b': [{ host: 'service-b.internal', port: 8080 }] },
      }),
    ],
  });
}

/** Uses discovery and brokered request/reply without requiring a real network. */
export async function callServiceB(app: IKernelApplication): Promise<string> {
  const discovery = app.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);
  const url = await discovery.resolveUrl('service-b', '/hello');
  if (url !== 'http://service-b.internal:8080/hello') {
    throw new Error(`Static discovery returned an unexpected URL: ${url}`);
  }
  const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
  const subscription = await broker.respond<
    { readonly name: string },
    { readonly greeting: string }
  >(
    'service-b.greet',
    (request) => ({ greeting: `Hello, ${request.name}!` }),
  );
  try {
    const reply = await broker.request<{ readonly name: string }, { readonly greeting: string }>(
      'service-b.greet',
      { name: 'service-a' },
    );
    return reply.greeting;
  } finally {
    await subscription.unsubscribe();
  }
}
