import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker, IServiceDiscovery, IServiceRegistry } from '@setu-ts/common';
import { GREETING_TOPIC, SERVICE_B } from '../greeting.contract.ts';
import type { GreetingReply, GreetingRequest } from '../greeting.contract.ts';

/** Resolves service B through discovery and asks its HTTP route for a greeting. */
export async function greetOverHttp(services: IServiceRegistry): Promise<string> {
  const discovery = services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);
  const url = await discovery.resolveUrl(SERVICE_B, '/hello');
  if (url === null) throw new Error(`Service discovery did not resolve ${SERVICE_B}.`);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`${SERVICE_B} returned ${response.status} at ${url}.`);
  const { greeting } = (await response.json()) as Partial<GreetingReply>;
  if (greeting === undefined) throw new Error(`${SERVICE_B} returned no greeting.`);
  return greeting;
}

/** Asks service B for a greeting through the shared broker. */
export async function greetOverBroker(services: IServiceRegistry): Promise<string> {
  const broker = services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
  const reply = await broker.request<GreetingRequest, GreetingReply>(GREETING_TOPIC, {
    name: 'service-a',
  });
  return reply.greeting;
}
