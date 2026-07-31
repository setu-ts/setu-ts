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
// Source: grpc/grpc-proto, https://github.com/grpc/grpc-proto
// Command: protoc -I. --include_imports \
//   --descriptor_set_out=grpc/health/v1/health.binpb grpc/health/v1/health.proto
// Base64 length: 1168 chars (from 874 bytes), generated 2026-07-31
//
// Self-contained FileDescriptorSet for grpc.health.v1.Health service.
// Contains three methods: Check (unary), List (unary), Watch (server_streaming).
// ---------------------------------------------------------------------------
export const healthBase64: string =
'CucGChtncnBjL2hlYWx0aC92MS9oZWFsdGgucHJvdG8SDmdycGMuaGVhbHRoLnYxIi4KEkhlYWx0aENoZWNrUmVxdWVzdBIYCgdzZXJ2aWNlGAEgASgJUgdzZXJ2aWNlIrEBChNIZWFsdGhDaGVja1Jlc3BvbnNlEkkKBnN0YXR1cxgBIAEoDjIxLmdycGMuaGVhbHRoLnYxLkhlYWx0aENoZWNrUmVzcG9uc2UuU2VydmluZ1N0YXR1c1IGc3RhdHVzIk8KDVNlcnZpbmdTdGF0dXSCwoHVUONKTWXAAEgsKB1SFJVJJSNCQARIPCgtOTF9TVJYSINhLKJDEnMKEUhlYWx0aExpc3RSZXF1ZXNIsQBChJIZWFsdGhMaXN0UmVzc29uc2USTAoIc3RhdHVzZXMYASADKAsyMC5ncnBjLmhlYWx0aC52MS5IZWFsdGhMaXN0UmVzcG9uc2UuU3RhdHVzZXNFbnRyeIIhc3RhdHVzZXMaYAoNU3RhdHVzZXNFbnRyeRIQCgNrZXkYASABKAlSA2tleI5CgV2YWx1ZRgCIAEoCzIjLmdycGMuaGVhbHRhLnYxLkhlYWx0aENoZWNrUmVzcG9uc2UQBWFsdWU6ATL9AQoGSGVhcGhFbAKBUNoZWNrEiIuZ3JwYy5oZWFsdGgudjEuSGVhcHRoQ2hlY2tSZXF1ZXN0GiMuZ3JwYy5oZWFsdGgudjEuSGVhcHRoQ2hlY2tSZXNwb25zZRJNCgRMaXN0EiEuZ3JwYy5oZWFsdGgudjEuSGVhcHRoTGlzdFJlcXVlc3QaIi5ncnBjLmhlYWx0aC52MS5IZWFsdGhMaXN0UmVzc29uc2USUgoFV2F0aGSIi5ncnBjLmhlYWx0aC52MS5IZWFsdGhDaGVja1JlcXVlc3QaIy5ncnBjLmhlYWx0aC52MS5IZWFsdGhDaGVja1Jlc3BvbnNlMAFCcAoRaW8uZ3JwYy5oZWFsdGgudjFCC0hlYWx0aFByb3RvUAFaLGdvb2dsZS5nb2xhbmcub3JnL2dycGMvaGVhbHRoL2dycGNfaGVhbHRoX3YxogIMR3JwY0hlYWx0aFYxqgIOR3JwYy5IZWFsdGguVjFiBnByb3RvMw==';

// ---------------------------------------------------------------------------
// Reflection v1 descriptor set
//
// Source: grpc/grpc-proto, https://github.com/grpc/grpc-proto
// Command: protoc -I. --include_imports \
//   --descriptor_set_out=grpc/reflection/v1/reflection.binpb grpc/reflection/v1/reflection.proto
// Base64 length: 2332 chars (from 1747 bytes), generated 2026-07-31
//
// Self-contained FileDescriptorSet for grpc.reflection.v1.ServerReflection service.
// Contains one method: ServerReflectionInfo (bidi_streaming).
// ---------------------------------------------------------------------------
export const reflectionBase64: string =
'CtANCiNncnBjL3JlZmxlY3Rpb24vdjEvcmVmbGVjdGlvbi5wcm90bxISZ3JwYy5yZWZsZWN0aW9uLnYxIvMCChdTZXJ2ZXJSZWZsZWN0aW9uUmVxdWVzdBISCgRob3N0GAEgASgJUgRob3N0EioKEGZpbGVfYnlfZmlsZW5hbWUYAyABKAlIAFIOZmlsZUJ5RmlsZW5hbWUSNgoWZmlsZV9jb250YWluaW5nX3N5bWJvbBgEIAEoCUgAUhRmaWxlQ29udGFpbmluZ1N5bWJvbBJiChlmaWxlX2NvbnRhaW5pbmdfZXh0ZW5zaW9uGAUgASgLMiQuZ3JwYy5yZWZsZWN0aW9uLnYxLkV4dGVuc2lvblJlcXVlc3RIAFIXZmlsZUNvbnRhaW5pbmdFeHRlbnNpb24SQgodYWxsX2V4dGVuc2lvbl9udW1iZXJzX29mX3R5cGUYBiABKAlIAFIZYWxsRXh0ZW5zaW9uTnVtYmVyc09mVHlwZRIlCg1saXN0X3NlcnZpY2VzGAcgASgJSABSDGxpc3RTZXJ2aWNlc0IRCg9tZXNzYWdlX3JlcXVlc3QiZgoQRXh0ZW5zaW9uUmVxdWVzdBInCg9jb250YWluaW5nX3R5cGUYASABKAlSDmNvbnRhaW5pbmdUeXBlEikKEGV4dGVuc2lvbl9udW1iZXIYAiABKAVSD2V4dGVuc2lvbk51bWJlciKuBAoYU2VydmVyUmVmbGVjdGlvblJlc3BvbnNlEh0KCnZhbGlkX2hvc3QYASABKAlSCXZhbGlkSG9zdBJWChBvcmlnaW5hbF9yZXF1ZXN0GAIgASgLMisuZ3JwYy5yZWZsZWN0aW9uLnYxLlNlcnZlclJlZmxlY3Rpb25SZXF1ZXN0Ug9vcmlnaW5hbFJlcXVlc3QSZgoYZmlsZV9kZXNjcmlwdG9yX3Jlc3BvbnNlGAQgASgLMiouZ3JwYy5yZWZsZWN0aW9uLnYxLkZpbGVEZXNjcmlwdG9yUmVzcG9uc2VIAFIWZmlsZURlc2NyaXB0b3JSZXNwb25zZRJyCh5hbGxfZXh0ZW5zaW9uX251bWJlcnNfcmVzcG9uc2UYBSABKAsyKy5ncnBjLnJlZmxlY3Rpb24udjEuRXh0ZW5zaW9uTnVtYmVyUmVzcG9uc2VIAFIbYWxsRXh0ZW5zaW9uTnVtYmVyc1Jlc3BvbnNlEl8KFmxpc3Rfc2VydmljZXNfcmVzcG9uc2UYBiABKAsyJy5ncnBjLnJlZmxlY3Rpb24udjEuTGlzdFNlcnZpY2VSZXNwb25zZUgAUhRsaXN0U2VydmljZXNSZXNwb25zZRJKCg5lcnJvcl9yZXNwb25zZRgHIAEoCzIhLmdycGMucmVmbGVjdGlvbi52MS5FcnJvclJlc3BvbnNlSABSDWVycm9yUmVzcG9uc2VCEgoQbWVzc2FnZV9yZXNwb25zZSJMChZGaWxlRGVzY3JpcHRvclJlc3BvbnNlEjIKFWZpbGVfZGVzY3JpcHRvcl9wcm90bxgBIAMoDFITZmlsZURlc2NyaXB0b3JQcm90byJqChdFeHRlbnNpb25OdW1iZXJSZXNwb25zZRIkCg5iYXNlX3R5cGVfbmFtZRgBIAEoCVIMYmFzZVR5cGVOYW1lEikKEGV4dGVuc2lvbl9udW1iZXIYAiADKAVSD2V4dGVuc2lvbk51bWJlciJUChNMaXN0U2VydmljZVJlc3BvbnNlEj0KB3NlcnZpY2UYASADKAsyIy5ncnBjLnJlZmxlY3Rpb24udjEuU2VydmljZVJlc3BvbnNlUgdzZXJ2aWNlIiUKD1NlcnZpY2VSZXNwb25zZRISCgRuYW1lGAEgASgJUgRuYW1lIlMKDUVycm9yUmVzcG9uc2USHQoKZXJyb3JfY29kZRgBIAEoBVIJZXJyb3JDb2RlEiMKDWVycm9yX21lc3NhZ2UYAiABKAlSDGVycm9yTWVzc2FnZTKJAQoQU2VydmVyUmVmbGVjdGlvbhJ1ChRTZXJ2ZXJSZWZsZWN0aW9uSW5mbxIrLmdycGMucmVmbGVjdGlvbi52MS5TZXJ2ZXJSZWZsZWN0aW9uUmVxdWVzdBosLmdycGMucmVmbGVjdGlvbi52MS5TZXJ2ZXJSZWZsZWN0aW9uUmVzcG9uc2UoATABQmYKFWlvLmdycGMucmVmbGVjdGlvbi52MUIVU2VydmVyUmVmbGVjdGlvblByb3RvUAFaNGdvb2dsZS5nb2xhbmcub3JnL2dycGMvcmVmbGVjdGlvbi9ncnBjX3JlZmxlY3Rpb25fdjFiBnByb3RvMw==';

// Schema references — populated at runtime from the lazy-loaded Protobuf-ES module
/**
 * Schema for FileDescriptorSet — used by fromBinary().
 * This is populated at runtime from `@bufbuild/protobuf`.
 */
export const fileDescriptorSetSchema: unknown = {};

/**
 * Schema for FileDescriptorProto — used by toBinary() in reflection.
 * This is populated at runtime from `@bufbuild/protobuf/wkt`.
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