/** The brokered topic service B answers greetings on. */
export const GREETING_TOPIC = 'service-b.greet';

/** The name service discovery resolves service B under. */
export const SERVICE_B = 'service-b';

export interface GreetingRequest {
  readonly name: string;
}

export interface GreetingReply {
  readonly greeting: string;
}

/** Builds the greeting both service B's route and its responder answer with. */
export function greetingFor(name: string): GreetingReply {
  return { greeting: `Hello, ${name}!` };
}
