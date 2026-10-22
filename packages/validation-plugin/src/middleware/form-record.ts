/** Convert ordered form fields into schema input without prototype writes. @module */
import type { FormBody, FormValue } from '@setu-ts/common';

/** Preserve field names, file values and wire order; [] keys always hold arrays. */
export function formRecord(form: FormBody): Record<string, FormValue | FormValue[]> {
  const record: Record<string, FormValue | FormValue[]> = Object.create(null);
  for (const [key, value] of form.entries()) {
    if (Object.hasOwn(record, key)) {
      const previous = record[key];
      if (Array.isArray(previous)) previous.push(value);
      else
        Object.defineProperty(record, key, {
          value: [previous, value],
          writable: true,
          enumerable: true,
          configurable: true,
        });
    } else {
      Object.defineProperty(record, key, {
        value: key.endsWith('[]') ? [value] : value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return record;
}
