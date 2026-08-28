import type {
  IMessageBroker,
  ISubscription,
  MessageHandler,
  RequestOptions,
  SubscribeOptions,
} from '@setu-ts/common';

/**
 * Internal broker adapter interface extending IMessageBroker with readiness check.
 *
 * This internal seam adds `isReady()` (lifecycle) and `reachability()`
 * (tri-state reachability) for health reporting, which are not part of the
 * public IMessageBroker contract.
 *
 * The three questions are deliberately separate (M70c):
 *
 * - {@linkcode isReady} is **lifecycle**: `connect()` was called and
 *   `disconnect()` was not. A broker that is connected but whose backend has
 *   gone away is still `ready`.
 * - {@linkcode reachability} is **reachability, tri-state**: `true` (the
 *   backend answers), `false` (the backend is unreachable), or `undefined`
 *   (the broker cannot probe — the injected client lacks the liveness
 *   member). The plugin's indicator maps this to `data.reachable` and the
 *   status.
 * - {@linkcode isHealthy} (inherited from `IMessageBroker`) is the **boolean**
 *   port member: `false` only when positively unreachable; `undefined`
 *   reachability reports `true` ("not known down"), because the port contract
 *   is boolean and the indicator surfaces the honest tri-state via
 *   `reachability()`.
 *
 * The indicator reports both: `isReady() === false` is `down`, and a
 * ready-but-unreachable broker is `down` with `data.reachable: false` — the
 * distinction an operator needs to tell "we never started" from "the broker
 * restarted under us".
 *
 * @since 0.1.0
 */
export interface MessageBrokerAdapter extends IMessageBroker {
  /** Publishes a message with framework-owned transport headers. */
  publishWithHeaders<T>(
    topic: string,
    message: T,
    headers: Readonly<Record<string, string>>,
  ): Promise<void>;
  /** Subscribes through the header-aware internal path. */
  subscribeWithHeaders<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription>;
  /** Sends RPC traffic with framework-owned transport headers. */
  requestWithHeaders<TReq, TRes>(
    topic: string,
    message: TReq,
    headers: Readonly<Record<string, string>>,
    options?: RequestOptions,
  ): Promise<TRes>;
  /**
   * Checks if the broker is connected and ready (lifecycle).
   *
   * @returns `true` if the broker is connected, `false` otherwise
   * @since 0.1.0
   */
  isReady(): boolean;
  /**
   * Reports the broker's backend reachability, tri-state (M70c).
   *
   * @returns `true` when reachable, `false` when unreachable, `undefined`
   *   when the broker cannot probe (the client facade lacks the liveness
   *   member)
   * @since 0.1.0
   */
  reachability(): Promise<boolean | undefined>;
}
