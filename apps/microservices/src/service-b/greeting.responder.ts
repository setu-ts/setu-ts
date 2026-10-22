import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker, IServiceRegistry, ISubscription } from '@setu-ts/common';
import { GREETING_TOPIC, greetingFor } from '../greeting.contract.ts';
import type { GreetingReply, GreetingRequest } from '../greeting.contract.ts';

/** Answers brokered greeting requests until the returned subscription is unsubscribed. */
export async function respondToGreetings(services: IServiceRegistry): Promise<ISubscription> {
  const broker = services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
  return await broker.respond<GreetingRequest, GreetingReply>(GREETING_TOPIC, (request) =>
    greetingFor(request.name),
  );
}
