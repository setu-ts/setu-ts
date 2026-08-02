/**
 * gRPC Server Reflection v1 — implements `grpc.reflection.v1.ServerReflectionInfo`.
 *
 * ## Wire shape (verified against the real runtime, not inferred from the proto)
 *
 * Both messages carry a oneof, and Protobuf-ES v2 represents a oneof as a
 * single property named after the oneof — NOT as flat sibling fields:
 *
 * - request: `{ messageRequest: { case: 'listServices', value: '' } }`
 * - response: `{ messageResponse: { case: 'listServicesResponse', value: {…} } }`
 *
 * The `case` values are the fields' camelCase `localName`s. Connect serializes
 * that object to the flat JSON the wire expects
 * (`{"listServicesResponse":{"service":[…]}}`), so the wrapper is an in-memory
 * representation only. Returning a flat object instead produces a silently
 * EMPTY response — every field is unset because none of them is the oneof.
 *
 * Connect accepts a plain init object here: `$typeName` and `create()` are not
 * required, which is what keeps this module free of a Protobuf-ES import.
 *
 * @module
 */

import type { ReflectionRegistry } from '../descriptors/descriptor-registry.ts';

/**
 * gRPC status codes used in a reflection `error_response`.
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
const GRPC_STATUS = {
  NOT_FOUND: 5,
  UNIMPLEMENTED: 12,
} as const;

/** The oneof arms a `ServerReflectionRequest` can carry. */
type RequestCase =
  | 'fileByFilename'
  | 'fileContainingSymbol'
  | 'fileContainingExtension'
  | 'allExtensionNumbersOfType'
  | 'listServices';

/** A `ServerReflectionRequest` as Protobuf-ES hands it to the handler. */
interface ServerReflectionRequest {
  readonly host?: string;
  readonly messageRequest?: {
    readonly case?: RequestCase;
    readonly value?: unknown;
  };
}

/** `grpc.reflection.v1.ExtensionRequest`. */
interface ExtensionRequest {
  readonly containingType?: string;
  readonly extensionNumber?: number;
}

/** A `ServerReflectionResponse` init object, as Connect accepts it. */
interface ServerReflectionResponse {
  readonly validHost?: string;
  readonly originalRequest?: ServerReflectionRequest;
  readonly messageResponse:
    | { case: 'listServicesResponse'; value: { service: { name: string }[] } }
    | { case: 'fileDescriptorResponse'; value: { fileDescriptorProto: Uint8Array[] } }
    | {
      case: 'allExtensionNumbersResponse';
      value: { baseTypeName: string; extensionNumber: number[] };
    }
    | { case: 'errorResponse'; value: { errorCode: number; errorMessage: string } };
}

/** Builds an `error_response` arm. */
function errorResponse(errorCode: number, errorMessage: string): ServerReflectionResponse {
  return { messageResponse: { case: 'errorResponse', value: { errorCode, errorMessage } } };
}

/** Builds a `file_descriptor_response` arm. */
function fileResponse(fileDescriptorProto: Uint8Array): ServerReflectionResponse {
  return {
    messageResponse: {
      case: 'fileDescriptorResponse',
      value: { fileDescriptorProto: [fileDescriptorProto] },
    },
  };
}

/**
 * Answers a single reflection request. Split out from the streaming loop so
 * every variant is unit-testable without driving an async generator.
 *
 * @param registry - The reflection index.
 * @param request - One `ServerReflectionRequest`.
 * @returns The `ServerReflectionResponse` to send back, echoing the original
 *   request as the spec requires.
 */
export function answerReflectionRequest(
  registry: ReflectionRegistry,
  request: ServerReflectionRequest,
): ServerReflectionResponse {
  const answer = ((): ServerReflectionResponse => {
    const { case: requestCase, value } = request.messageRequest ?? {};

    switch (requestCase) {
      case 'listServices': {
        return {
          messageResponse: {
            case: 'listServicesResponse',
            value: { service: registry.listServices().map((name) => ({ name })) },
          },
        };
      }

      case 'fileByFilename': {
        const filename = String(value ?? '');
        const bytes = registry.getFileByName(filename);
        return bytes === undefined
          ? errorResponse(GRPC_STATUS.NOT_FOUND, `file not found: ${filename}`)
          : fileResponse(bytes);
      }

      case 'fileContainingSymbol': {
        const symbol = String(value ?? '');
        const bytes = registry.getFileContainingSymbol(symbol);
        return bytes === undefined
          ? errorResponse(GRPC_STATUS.NOT_FOUND, `symbol not found: ${symbol}`)
          : fileResponse(bytes);
      }

      case 'allExtensionNumbersOfType': {
        const typeName = String(value ?? '');
        const numbers = registry.getExtensionNumbers(typeName);
        if (numbers === undefined) {
          return errorResponse(GRPC_STATUS.NOT_FOUND, `type not found: ${typeName}`);
        }
        return {
          messageResponse: {
            case: 'allExtensionNumbersResponse',
            value: { baseTypeName: typeName, extensionNumber: [...numbers] },
          },
        };
      }

      case 'fileContainingExtension': {
        // Deliberately unimplemented: the framework registers no extensions, so
        // there is nothing this could return. Documented in the README and the
        // PUBLIC_API notes rather than answered with a misleading NOT_FOUND.
        const extension = (value ?? {}) as ExtensionRequest;
        return errorResponse(
          GRPC_STATUS.UNIMPLEMENTED,
          'file_containing_extension is not supported: ' +
            `no extensions are registered (containing_type=${extension.containingType ?? ''})`,
        );
      }

      default: {
        return errorResponse(
          GRPC_STATUS.UNIMPLEMENTED,
          `unsupported reflection request: ${requestCase ?? '(none set)'}`,
        );
      }
    }
  })();

  // The spec requires every response to echo the request that produced it.
  return { ...answer, originalRequest: request };
}

/**
 * Creates the `grpc.reflection.v1.ServerReflection` implementation.
 *
 * `ServerReflectionInfo` is the service's sole method and it is
 * **bidi-streaming**, so reflection requires a genuinely full-duplex transport
 * (HTTP/2, or in-process `app.fetch`). Over a real HTTP/1.1 socket it fails at
 * the transport while unary RPCs on the same port keep working — see the plugin
 * README's transport note.
 *
 * @param registry - The reflection index built at router-build time.
 */
export function createReflectionService(
  registry: ReflectionRegistry,
): Record<string, unknown> {
  return {
    async *serverReflectionInfo(
      requests: AsyncIterable<ServerReflectionRequest>,
    ): AsyncGenerator<ServerReflectionResponse> {
      for await (const request of requests) {
        yield answerReflectionRequest(registry, request);
      }
    },
  };
}
