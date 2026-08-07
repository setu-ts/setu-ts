import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker, IServiceDiscovery } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { MessagingPlugin } from '@setu-ts/messaging-plugin';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ServiceDiscoveryPlugin } from '@setu-ts/service-discovery-plugin';

/** Builds service B with a network endpoint and optional Redis broker. */
export function createServiceB(redisUrl?: string): IKernelApplication {
  const plugins = [RuntimePlugin()];
  if (redisUrl !== undefined) {
    plugins.push(MessagingPlugin({ broker: 'redis-streams', url: redisUrl }));
  }
  const app = createApplication({ plugins });
  app.router.get(
    '/hello',
    (ctx) => ctx.response.json({ greeting: 'Hello, service-a!' }),
  );
  return app;
}

/** Builds service A with a static route to service B and optional Redis broker. */
export function createServiceA(serviceBPort: number, redisUrl?: string): IKernelApplication {
  const plugins = [RuntimePlugin()];
  if (redisUrl !== undefined) {
    plugins.push(MessagingPlugin({ broker: 'redis-streams', url: redisUrl }));
  }
  plugins.push(
    ServiceDiscoveryPlugin({
      provider: 'static',
      services: { 'service-b': [{ host: '127.0.0.1', port: serviceBPort }] },
    }),
  );
  return createApplication({ plugins });
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

/** Registers service B's Redis-backed request/reply handler. */
export async function registerGreetingResponder(
  app: IKernelApplication,
): Promise<() => Promise<void>> {
  const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
  const subscription = await broker.respond<
    { readonly name: string },
    { readonly greeting: string }
  >(
    'service-b.greet',
    (request) => ({ greeting: `Hello, ${request.name}!` }),
  );
  return () => subscription.unsubscribe();
}

/** Asks service B for a greeting through service A's networked broker. */
export async function brokeredGreeting(app: IKernelApplication): Promise<string> {
  const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
  const reply = await broker.request<
    { readonly name: string },
    { readonly greeting: string }
  >(
    'service-b.greet',
    { name: 'service-a' },
  );
  return reply.greeting;
}
