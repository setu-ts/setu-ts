/**
 * Tests for duration parsing utility.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { parseDuration } from '../../src/utils/duration.ts';

describe('parseDuration', () => {
  describe('seconds suffix', () => {
    it('parses "30s" to 30000ms', () => {
      expect(parseDuration('30s')).toBe(30000);
    });

    it('parses "1s" to 1000ms', () => {
      expect(parseDuration('1s')).toBe(1000);
    });
  });

  describe('minutes suffix', () => {
    it('parses "5m" to 300000ms', () => {
      expect(parseDuration('5m')).toBe(300000);
    });

    it('parses "1m" to 60000ms', () => {
      expect(parseDuration('1m')).toBe(60000);
    });
  });

  describe('hours suffix', () => {
    it('parses "1h" to 3600000ms', () => {
      expect(parseDuration('1h')).toBe(3600000);
    });

    it('parses "2h" to 7200000ms', () => {
      expect(parseDuration('2h')).toBe(7200000);
    });
  });

  describe('days suffix', () => {
    it('parses "7d" to 604800000ms', () => {
      expect(parseDuration('7d')).toBe(604800000);
    });

    it('parses "1d" to 86400000ms', () => {
      expect(parseDuration('1d')).toBe(86400000);
    });
  });

  describe('bare integer seconds', () => {
    it('parses "60" to 60000ms', () => {
      expect(parseDuration('60')).toBe(60000);
    });

    it('parses "3600" to 3600000ms', () => {
      expect(parseDuration('3600')).toBe(3600000);
    });
  });

  describe('decimal values', () => {
    it('parses "1.5h" to 5400000ms', () => {
      expect(parseDuration('1.5h')).toBe(5400000);
    });

    it('parses "30.5s" to 30500ms', () => {
      expect(parseDuration('30.5s')).toBe(30500);
    });
  });

  describe('whitespace handling', () => {
    it('trims leading and trailing whitespace', () => {
      expect(parseDuration('  1h  ')).toBe(3600000);
    });
  });

  describe('error cases', () => {
    it('throws on empty string', () => {
      expect(() => parseDuration('')).toThrow('Duration cannot be empty');
    });

    it('throws on invalid format', () => {
      expect(() => parseDuration('abc')).toThrow('Invalid duration format');
    });

    it('throws on invalid unit', () => {
      expect(() => parseDuration('1x')).toThrow('Invalid duration format');
    });
  });
});
