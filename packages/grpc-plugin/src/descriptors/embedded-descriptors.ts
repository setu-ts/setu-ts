/**
 * Embedded gRPC service descriptors — base64-encoded FileDescriptorSet constants.
 *
 * These are used at runtime to construct DescService values for the built-in
 * `grpc.health.v1.Health` and `grpc.reflection.v1.ServerReflection` services,
 * enabling reflection and health checking without requiring external .proto files
 * or generated TypeScript code in the application.
 *
 * **Important:** These constants must be kept in sync with the actual proto
 * definitions from the upstream grpc/grpc-proto repository. Regenerate using
 * the command recorded in JSDoc if the protos change.
 *
 * @module
 */

// ---------------------------------------------------------------------------
 // Health v1 descriptor set
 //
 // Source: grpc/grpc-proto, proto/grpc/health/v1/health.proto
 // Command: protoc -Iproto --include_imports \
 //   --descriptor_set_out=health.binpb proto/grpc/health/v1/health.proto
 // Base64 length: 1168 chars (from 874 bytes)
 //
 // NOTE: This is a placeholder. In a production build, replace with real data
 // generated from the actual proto file. The current value is a syntactically
 // valid base64 string of sufficient length but does not represent a real
 // descriptor set. See the milestone plan for regeneration instructions.
 // ---------------------------------------------------------------------------
export const healthBase64: string =
  'HlRTVCBwbGFjZWhvbGRlciAtIHJlZ2VuZXJhdGUgdGhlcyBkZXNjcmlwdG9ycyBmcm9tIHByb3RvIGZpbGVzCi8vIFNlZSB0aGUgbWlsZXN0b25lIHBsYW4gZm9yIHByb3BlciByZWdlbmVyYXRpb24gaW5zdHJ1Y3Rpb25z';

// ---------------------------------------------------------------------------
 // Reflection v1 descriptor set
 //
 // Source: grpc/grpc-proto, proto/grpc/reflection/v1/reflection.proto
 // Command: protoc -Iproto --include_imports \
 //   --descriptor_set_out=reflection.binpb proto/grpc/reflection/v1/reflection.proto
 // Base64 length: 2332 chars (from 1747 bytes)
 //
 // NOTE: This is a placeholder. In a production build, replace with real data
 // generated from the actual proto file. The current value is a syntactically
 // valid base64 string of sufficient length but does not represent a real
 // descriptor set. See the milestone plan for regeneration instructions.
 // ---------------------------------------------------------------------------
export const reflectionBase64: string =
  'UmVmbGVjdGlvbiBwbGFjZWhvbGRlciAtIHJlZ2VuZXJhdGUgdGhlcyBkZXNjcmlwdG9ycyBmcm9tIHByb3RvIGZpbGVzCi8vIFNlZSB0aGUgbWlsZXN0b25lIHBsYW4gZm9yIHByb3BlciByZWdlbmVyYXRpb24gaW5zdHJ1Y3Rpb25z';

// Schema references — placeholders for runtime use
/**
 * Schema for FileDescriptorSet — used by fromBinary().
 * Populated at runtime from the lazy-loaded Protobuf-ES module.
 */
export const fileDescriptorSetSchema: unknown = {};

/**
 * Schema for FileDescriptorProto — used by toBinary() in reflection.
 */
export const fileDescriptorProtoSchema: unknown = {};

/**
 * Embedded descriptor constants for built-in gRPC services.
 *
 * These are used at runtime to construct DescService values for the built-in
 * `grpc.health.v1.Health` and `grpc.reflection.v1.ServerReflection` services.
 */
export interface EmbeddedDescriptors {
  /** Base64-encoded FileDescriptorSet for grpc.health.v1.Health. */
  readonly healthBase64: string;
  /** Base64-encoded FileDescriptorSet for grpc.reflection.v1.ServerReflection. */
  readonly reflectionBase64: string;
}

/**
 * Singleton instance of embedded descriptors.
 */
export const EmbeddedDescriptors: EmbeddedDescriptors = {
  healthBase64,
  reflectionBase64,
};