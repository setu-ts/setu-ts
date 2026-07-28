import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames, isIdentifierSafe } from '../../src/utils/names.ts';

describe('deriveNames', () => {
  const inputs = ['user-profile', 'UserProfile', 'userProfile', 'user_profile', 'user profile'];

  for (const input of inputs) {
    it(`derives identical forms from "${input}"`, () => {
      const names = deriveNames(input);
      expect(names.kebab).toBe('user-profile');
      expect(names.camel).toBe('userProfile');
      expect(names.pascal).toBe('UserProfile');
      expect(names.screaming).toBe('USER_PROFILE');
    });
  }

  it('preserves the raw input verbatim', () => {
    expect(deriveNames('  UserProfile ').raw).toBe('  UserProfile ');
  });

  it('handles a single lowercase word', () => {
    expect(deriveNames('user')).toEqual({
      raw: 'user',
      kebab: 'user',
      camel: 'user',
      pascal: 'User',
      screaming: 'USER',
    });
  });

  it('handles a single Pascal word', () => {
    const names = deriveNames('User');
    expect(names.kebab).toBe('user');
    expect(names.camel).toBe('user');
    expect(names.pascal).toBe('User');
  });

  it('splits three or more words', () => {
    const names = deriveNames('createUserProfileCommand');
    expect(names.kebab).toBe('create-user-profile-command');
    expect(names.pascal).toBe('CreateUserProfileCommand');
    expect(names.screaming).toBe('CREATE_USER_PROFILE_COMMAND');
  });

  it('collapses repeated separators', () => {
    expect(deriveNames('user--profile__name').kebab).toBe('user-profile-name');
  });

  it('returns empty forms for an empty input', () => {
    expect(deriveNames('')).toEqual({
      raw: '',
      kebab: '',
      camel: '',
      pascal: '',
      screaming: '',
    });
  });

  it('returns empty forms for a separator-only input', () => {
    expect(deriveNames('---').kebab).toBe('');
  });

  it('lowercases the tail of an all-caps segment', () => {
    expect(deriveNames('API').pascal).toBe('Api');
  });

  it('keeps digits attached to their word', () => {
    expect(deriveNames('oauth2-client').pascal).toBe('Oauth2Client');
  });
});

describe('isIdentifierSafe', () => {
  it('accepts an ordinary name', () => {
    expect(isIdentifierSafe(deriveNames('user-profile'))).toBe(true);
  });

  it('accepts a reserved word, which every schematic prefixes or suffixes', () => {
    for (const word of ['class', 'new', 'for', 'return', 'function', 'default']) {
      expect(isIdentifierSafe(deriveNames(word))).toBe(true);
    }
  });

  it('accepts a name containing digits after the first character', () => {
    expect(isIdentifierSafe(deriveNames('oauth2-client'))).toBe(true);
  });

  it('rejects a name that normalises to nothing', () => {
    // Would emit `class Service` at the hidden path src/services/.service.ts.
    for (const raw of ['', '___', '---', '   ']) {
      expect(isIdentifierSafe(deriveNames(raw))).toBe(false);
    }
  });

  it('rejects a digit-leading name', () => {
    // Would emit `class 2faService`, which does not parse.
    for (const raw of ['2fa', '3d-model', '0auth']) {
      expect(isIdentifierSafe(deriveNames(raw))).toBe(false);
    }
  });
});
