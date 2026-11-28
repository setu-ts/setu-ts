// The SDK exports this translator internally, beside its public entry point.
const errorModuleUrl = new URL('./serviceBusError.js', import.meta.resolve('@azure/service-bus'));
const { translateServiceBusError } = (await import(errorModuleUrl.href)) as {
  translateServiceBusError(error: unknown): Error;
};

/**
 * Conditions translated by the installed SDK, with ordinary and aggregate outage expectations.
 * @since 0.14.0
 */
export const serviceBusFaults = [
  {
    condition: 'amqp:not-found',
    code: 'ServiceCommunicationProblem',
    outage: true,
    aggregateOutage: true,
  },
  {
    condition: 'com.microsoft:timeout',
    code: 'ServiceTimeout',
    outage: true,
    aggregateOutage: true,
  },
  {
    condition: 'com.microsoft:server-busy',
    code: 'ServiceBusy',
    outage: true,
    aggregateOutage: true,
  },
  { condition: 'amqp:internal-error', code: 'GeneralError', outage: true, aggregateOutage: true },
  {
    condition: 'com.microsoft:session-lock-lost',
    code: 'SessionLockLost',
    outage: false,
    aggregateOutage: true,
  },
  {
    condition: 'amqp:unauthorized-access',
    code: 'UnauthorizedAccess',
    outage: false,
    aggregateOutage: false,
  },
  {
    condition: 'amqp:not-found',
    description: 'The messaging entity orders could not be found.',
    code: 'MessagingEntityNotFound',
    outage: false,
    aggregateOutage: false,
  },
  {
    condition: 'com.microsoft:entity-disabled',
    code: 'MessagingEntityDisabled',
    outage: false,
    aggregateOutage: false,
  },
  {
    condition: 'amqp:link:message-size-exceeded',
    code: 'MessageSizeExceeded',
    outage: false,
    aggregateOutage: false,
  },
  {
    condition: 'amqp:resource-limit-exceeded',
    code: 'QuotaExceeded',
    outage: false,
    aggregateOutage: false,
  },
].map(({ condition, code, outage, aggregateOutage, ...rest }) => ({
  code,
  outage,
  aggregateOutage,
  error: translateServiceBusError({ condition, description: 'fault', ...rest }),
}));
