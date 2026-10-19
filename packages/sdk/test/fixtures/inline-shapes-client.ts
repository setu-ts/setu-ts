/**
 * Auto-generated SDK client. Do not edit manually.
 */

import type { ClientResponse, IHttpClient, OperationRequestOptions } from '../../src/index.ts';

export type PlaceOrderBody = {
  'sku': string;
  'qty': number;
};
export type PlaceOrderResponse201 = {
  'id': string;
  'total'?: number;
};

export interface PlaceOrderArgs {
  body: PlaceOrderBody;
}

export interface Api {
  placeOrder(
    opts: PlaceOrderArgs,
    request?: OperationRequestOptions,
  ): Promise<ClientResponse<PlaceOrderResponse201>>;
}

export function createApi(client: IHttpClient): Api {
  /** place-order */
  function placeOrder(
    opts: PlaceOrderArgs,
    request?: OperationRequestOptions,
  ): Promise<ClientResponse<PlaceOrderResponse201>> {
    return client.request<PlaceOrderResponse201>({
      method: 'POST',
      path: 'orders',
      json: opts.body,
      ...(request?.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      ...(request?.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  return {
    placeOrder,
  };
}
