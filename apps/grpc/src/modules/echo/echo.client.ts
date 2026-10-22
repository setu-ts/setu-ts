import type * as protobuf from '@bufbuild/protobuf';
import * as connect from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { ECHO_SERVICE } from './echo.service.ts';

/** The client view of `example.EchoService` this example calls. */
export interface EchoClient {
  echo(request: { readonly message: string }): Promise<{ readonly response: string }>;
}

/** Creates a Connect client for `example.EchoService` at the given origin. */
export function createEchoClient(baseUrl: string): EchoClient {
  // The plugin's descriptor type is structural; Connect wants its own concrete one.
  const service = ECHO_SERVICE as unknown as protobuf.DescService;
  return connect.createClient(
    service,
    createConnectTransport({ baseUrl }),
  ) as unknown as EchoClient;
}
