import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';

/**
 * JsonSerializer unit tests.
 *
 * Tests serialization/deserialization round-trips for various data types.
 */
describe('JsonSerializer', () => {
  it('serialize/deserialize round-trip for objects', () => {
    const serializer = new JsonSerializer();
    const obj = { name: 'test', value: 123, nested: { foo: 'bar' } };

    const serialized = serializer.serialize(obj);
    const deserialized = serializer.deserialize<typeof obj>(serialized);

    expect(deserialized).toEqual(obj);
  });

  it('serialize/deserialize round-trip for arrays', () => {
    const serializer = new JsonSerializer();
    const arr = [1, 2, 3, 'four', { five: 5 }];

    const serialized = serializer.serialize(arr);
    const deserialized = serializer.deserialize<typeof arr>(serialized);

    expect(deserialized).toEqual(arr);
  });

  it('serialize/deserialize round-trip for nested values', () => {
    const serializer = new JsonSerializer();
    const nested = {
      level1: {
        level2: {
          level3: {
            data: 'deep',
          },
        },
      },
    };

    const serialized = serializer.serialize(nested);
    const deserialized = serializer.deserialize<typeof nested>(serialized);

    expect(deserialized).toEqual(nested);
  });

  it('serialize/deserialize round-trip for primitives', () => {
    const serializer = new JsonSerializer();

    // String
    const str = 'hello world';
    expect(serializer.deserialize<string>(serializer.serialize(str))).toEqual(str);

    // Number
    const num = 42.5;
    expect(serializer.deserialize<number>(serializer.serialize(num))).toEqual(num);

    // Boolean
    const bool = true;
    expect(serializer.deserialize<boolean>(serializer.serialize(bool))).toEqual(bool);

    // Null
    const nul = null;
    expect(serializer.deserialize<null>(serializer.serialize(nul))).toEqual(nul);
  });

  it('serialize/deserialize handles JSON-special characters', () => {
    const serializer = new JsonSerializer();
    const str = 'hello "world" with \'quotes\' and \\backslash\\';

    const serialized = serializer.serialize(str);
    const deserialized = serializer.deserialize<string>(serialized);

    expect(deserialized).toEqual(str);
  });

  it('deserialize handles non-object input', () => {
    const serializer = new JsonSerializer();

    // Array input
    const arr = [1, 2, 3];
    const serialized = serializer.serialize(arr);
    const deserialized = serializer.deserialize<number[]>(serialized);
    expect(Array.isArray(deserialized)).toBe(true);
    expect(deserialized).toEqual(arr);
  });

  it('serialize handles null', () => {
    const serializer = new JsonSerializer();

    expect(serializer.serialize(null)).toBe('null');
  });
});
