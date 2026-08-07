import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as exports from '../../src/index.ts';

describe('barrel exports', () => {
  it('exports QueuePlugin', () => {
    expect(exports.QueuePlugin).toBeDefined();
    expect(typeof exports.QueuePlugin).toBe('function');
  });

  it('exports MemoryQueue', () => {
    expect(exports.MemoryQueue).toBeDefined();
    expect(typeof exports.MemoryQueue).toBe('function');
  });

  it('exports RedisQueue', () => {
    expect(exports.RedisQueue).toBeDefined();
    expect(typeof exports.RedisQueue).toBe('function');
  });

  it('exports RabbitMqQueue', () => {
    expect(exports.RabbitMqQueue).toBeDefined();
    expect(typeof exports.RabbitMqQueue).toBe('function');
  });
});
