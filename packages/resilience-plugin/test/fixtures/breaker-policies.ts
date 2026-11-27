import type { CircuitBreakerPolicy } from '@setu-ts/common';

/** Invalid policy fields shared by the registration and wrap boundary tests. */
const count = { threshold: 3, timeout: 1000, resetTimeout: 500 };
const rate = { failureRateThreshold: 65, minimumCalls: 7, timeout: 1000, resetTimeout: 500 };
export const INVALID_BREAKER_POLICIES: readonly (readonly [string, CircuitBreakerPolicy])[] = [
  ['both arms', { ...count, failureRateThreshold: 50 }],
  ['both arms via minimumCalls', { ...count, minimumCalls: 1 }],
  ['neither arm', { timeout: 1000, resetTimeout: 0 }],
  ['minimumCalls alone', { minimumCalls: 1, timeout: 1000, resetTimeout: 0 }],
  ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((threshold) => [
    'threshold',
    { ...count, threshold },
  ]),
  ...[0, -1, NaN, Infinity, 2147483648].map((timeout) => ['timeout', { ...count, timeout }]),
  ...[0, 101, NaN, Infinity].map((failureRateThreshold) => [
    'failureRateThreshold',
    { ...rate, failureRateThreshold },
  ]),
  ...[undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((minimumCalls) => [
    'minimumCalls',
    { ...rate, minimumCalls },
  ]),
  ...[0, 9.9, NaN, Infinity, 2147483648].map((timeout) => ['rate timeout', { ...rate, timeout }]),
  ...[-1, NaN, Infinity, 2147483648].flatMap((resetTimeout) => [
    ['count resetTimeout', { ...count, resetTimeout }],
    ['rate resetTimeout', { ...rate, resetTimeout }],
  ]),
] as unknown as readonly (readonly [string, CircuitBreakerPolicy])[];
