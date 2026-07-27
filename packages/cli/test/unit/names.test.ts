/**
 * Unit tests for the name normalization utilities.
 *
 * @module
 */

import { deriveNames } from '../../src/utils/names.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('deriveNames', () => {
  it('derives all naming forms from kebab input', () => {
    const result = deriveNames('user-profile');
    expect(result).toEqual({
      raw: 'user-profile',
      kebab: 'user-profile',
      camel: 'userProfile',
      pascal: 'UserProfile',
      screaming: 'USER_PROFILE',
    });
  });

  it('derives all naming forms from camel input', () => {
    const result = deriveNames('userProfile');
    expect(result).toEqual({
      raw: 'userProfile',
      kebab: 'user-profile',
      camel: 'userProfile',
      pascal: 'UserProfile',
      screaming: 'USER_PROFILE',
    });
  });

  it('derives all naming forms from Pascal input', () => {
    const result = deriveNames('UserProfile');
    expect(result).toEqual({
      raw: 'UserProfile',
      kebab: 'user-profile',
      camel: 'userProfile',
      pascal: 'UserProfile',
      screaming: 'USER_PROFILE',
    });
  });

  it('derives all naming forms from single word', () => {
    const result = deriveNames('user');
    expect(result).toEqual({
      raw: 'user',
      kebab: 'user',
      camel: 'user',
      pascal: 'User',
      screaming: 'USER',
    });
  });

  it('handles input with spaces and underscores', () => {
    const result = deriveNames('user profile');
    expect(result.kebab).toBe('user-profile');
    expect(result.camel).toBe('userProfile');
    expect(result.pascal).toBe('UserProfile');
    expect(result.screaming).toBe('USER_PROFILE');
  });

  it('returns empty forms for empty input', () => {
    const result = deriveNames('');
    expect(result.raw).toBe('');
    expect(result.kebab).toBe('');
    expect(result.camel).toBe('');
    expect(result.pascal).toBe('');
    expect(result.screaming).toBe('');
  });
});
