/**
 * Encodes a flat body into replayable multipart form data. A `FormData` is
 * sent as given; any other body must be a plain object, because a class
 * instance such as `URLSearchParams` or `Map` has no own enumerable fields and
 * would otherwise encode to an empty form without an error.
 * @param body - A `FormData`, or a plain object of own enumerable form fields
 * @returns Form data with repeated keys for arrays
 * @throws {TypeError} For a body that is neither, or a value a flat form cannot
 *   carry, naming the field
 * @since 0.13.0
 */
export function encodeMultipart(body: object): FormData {
  if (body instanceof FormData) return body;
  const prototype: unknown = Object.getPrototypeOf(body);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('multipart must be a FormData or a plain object of form fields');
  }
  const form = new FormData();
  const append = (key: string, value: unknown): void => {
    if (value === undefined) return;
    if (value instanceof Blob) form.append(key, value);
    else if (typeof value === 'string') form.append(key, value);
    else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      form.append(key, String(value));
    } else throw new TypeError(`Unsupported multipart value for field '${key}'`);
  };
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value)) {
      for (const entry of value) append(key, entry);
    } else append(key, value);
  }
  return form;
}
