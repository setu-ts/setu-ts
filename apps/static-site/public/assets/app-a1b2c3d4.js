// A content-hashed bundle: the filename carries the hash, so this asset is
// immutable and must be served with a year-long Cache-Control whichever
// encoding the client negotiates.
export function greet(name) {
  return `hello, ${name}`;
}
