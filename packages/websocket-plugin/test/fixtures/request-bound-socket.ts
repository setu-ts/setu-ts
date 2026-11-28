/**
 * Fakes that reproduce workerd's request-ownership rule.
 *
 * workerd ties every I/O object to the request that created it; touching it
 * from another request throws "Cannot perform I/O on behalf of a different
 * request". A test that passes against fakes without that rule would pass
 * against the defect too, so every request-bound test runs on these: a
 * {@linkcode RequestWorld} names the request currently running, each socket and
 * link records the request that created it, and a foreign write throws and is
 * recorded as a violation.
 *
 * @module
 */

import type {
  IRealtimeConnectionLink,
  IRealtimeLinkBackplane,
  IWebSocketTransport,
  RealtimeFrame,
  WebSocketReadyState,
} from '@setu-ts/common';

/** The error workerd throws for cross-request I/O. */
export const FOREIGN_IO = 'Cannot perform I/O on behalf of a different request';

/** Which request is running, and every foreign-I/O attempt made. */
export class RequestWorld {
  current: string | undefined;
  readonly violations: string[] = [];

  /**
   * Runs `fn` as request `owner`.
   * @param owner - The request id
   * @param fn - The work
   * @returns What `fn` returns
   */
  run<T>(owner: string, fn: () => T): T {
    const previous = this.current;
    this.current = owner;
    try {
      return fn();
    } finally {
      this.current = previous;
    }
  }

  /**
   * Throws, and records a violation, when the running request is not `owner`.
   * @param owner - The object's owning request
   * @param what - What was touched, for the violation record
   */
  assertOwner(owner: string, what: string): void {
    if (this.current !== owner) {
      this.violations.push(`${what} owned by ${owner} touched from ${String(this.current)}`);
      throw new Error(FOREIGN_IO);
    }
  }
}

/** A Workers transport double: tracked state, owner-checked writes. */
export interface OwnedTransport extends IWebSocketTransport {
  readonly owner: string;
  readonly sent: (string | Uint8Array)[];
  readonly closes: { code: number | undefined; reason: string | undefined }[];
}

/**
 * Creates a transport owned by the running request. `readyState` is tracked
 * (as the Workers adapter's transport is) and never throws; `send` and `close`
 * throw from another request.
 * @param world - The request world
 * @returns The transport
 */
export function ownedTransport(world: RequestWorld): OwnedTransport {
  const owner = world.current ?? 'unknown';
  const sent: (string | Uint8Array)[] = [];
  const closes: { code: number | undefined; reason: string | undefined }[] = [];
  let state: WebSocketReadyState = 'open';
  return {
    owner,
    sent,
    closes,
    get readyState(): WebSocketReadyState {
      return state;
    },
    send(data: string | Uint8Array): void {
      world.assertOwner(owner, 'socket');
      sent.push(data);
    },
    close(code?: number, reason?: string): void {
      world.assertOwner(owner, 'socket');
      closes.push({ code, reason });
      state = 'closed';
    },
  };
}

/** A link held by the fake hub. */
interface HubLink {
  readonly owner: string;
  readonly deliver: (frame: RealtimeFrame) => void;
  closed: boolean;
}

/** One hub (a topic's Durable Object) shared by every isolate's backplane. */
export class FakeHub {
  readonly links = new Set<HubLink>();
  posts = 0;

  constructor(readonly world: RequestWorld) {}

  /** Sends a frame to every open link except `skip`, each in its owner's request. */
  fanOut(frame: RealtimeFrame, skip?: HubLink): void {
    for (const link of [...this.links]) {
      if (link === skip || link.closed) continue;
      this.world.run(link.owner, () => {
        link.deliver(frame);
      });
    }
  }

  /**
   * One isolate's backplane on this hub.
   * @param origin - The isolate's origin
   * @returns The backplane
   */
  backplane(origin: string): IRealtimeLinkBackplane {
    const world = this.world;
    const links = this.links;
    const fanOut = (frame: RealtimeFrame, skip?: HubLink): void => {
      this.fanOut(frame, skip);
    };
    const post = (frame: RealtimeFrame): Promise<void> => {
      this.posts++;
      this.fanOut(frame);
      return Promise.resolve();
    };
    return {
      origin,
      connect: () => Promise.resolve(),
      publish: () => Promise.resolve(),
      subscribe: () => Promise.resolve(() => {}),
      close: () => Promise.resolve(),
      openConnectionLink(_id, deliver): IRealtimeConnectionLink {
        const link: HubLink = { owner: world.current ?? 'unknown', deliver, closed: false };
        links.add(link);
        return {
          publish(frame: RealtimeFrame): boolean {
            if (link.closed || world.current !== link.owner) return false;
            fanOut(frame, link);
            return true;
          },
          close(): void {
            link.closed = true;
            links.delete(link);
          },
        };
      },
      publishViaHub: post,
    };
  }
}
