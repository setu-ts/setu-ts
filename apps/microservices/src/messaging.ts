import type { IPlugin } from '@setu-ts/common';
import { MessagingPlugin } from '@setu-ts/messaging-plugin';

/** The Redis Streams broker both services share, or nothing when no Redis is configured. */
export function optionalMessaging(redisUrl: string | undefined): IPlugin[] {
  return redisUrl === undefined
    ? []
    : [MessagingPlugin({ broker: 'redis-streams', url: redisUrl })];
}
