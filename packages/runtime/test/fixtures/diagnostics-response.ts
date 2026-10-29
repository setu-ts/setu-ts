import type { IResponse, ResponseSnapshot } from '@setu-ts/common';

/** Supplies exactly the response snapshot a transport test intends to send. */
export function diagnosticsResponse(
  snapshot: ResponseSnapshot = {
    streaming: false,
    status: 200,
    headers: new Headers({ 'content-type': 'text/plain' }),
    body: 'served',
  },
): IResponse {
  const unused = (): never => {
    throw new Error('Only snapshot is consumed by this transport');
  };
  return {
    status: unused,
    header: unused,
    appendHeader: unused,
    setHeaders: unused,
    json: unused,
    text: unused,
    html: unused,
    send: unused,
    redirect: unused,
    stream: unused,
    snapshot: () => snapshot,
  };
}
