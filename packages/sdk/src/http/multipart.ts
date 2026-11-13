/**
 * Encodes a flat body into replayable multipart form data.
 * @param body - Own enumerable form fields
 * @returns Form data with repeated keys for arrays
 * @throws {TypeError} For values a flat form cannot carry, naming the field
 * @since 0.13.0
 */
export function encodeMultipart(body: object): FormData {
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
