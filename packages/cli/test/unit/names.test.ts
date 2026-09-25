import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  deriveNames,
  escapeName,
  isIdentifierSafe,
  isPathSegmentSafe,
} from '../../src/utils/names.ts';

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

  // These survive normalisation intact — `deriveNames('.')` returns `.` for every
  // form — so the empty check passes them straight through. `setu adopt` derives
  // its member name from a directory, which made `--dir .` produce `apps/.`.
  it('rejects a path segment carrying no letter at all', () => {
    for (const input of ['.', '..', './']) {
      expect(isIdentifierSafe(deriveNames(input))).toBe(false);
    }
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

  // The kebab is joined into a filesystem path by every name-taking verb — the
  // `new` project dir, the `generate app`/`adopt` member dir, and the artifact
  // file name — and `deriveNames` preserves `/` verbatim: it is not a separator
  // it normalizes away. A name carrying one would write the scaffold outside the
  // intended directory, so the guard rejects it at the shared mechanism.
  it('rejects a name whose derived kebab carries a path separator', () => {
    for (const input of ['..', '.', '../sibling', '../../..', 'a/b']) {
      expect(isIdentifierSafe(deriveNames(input))).toBe(false);
    }
  });

  // A NUL byte and an over-long component pass every other rule and reach the
  // filesystem, which rejects them mid-flight (`TypeError: ... NUL byte`,
  // `File name too long`) as an error nothing caught — an uncaught rejection,
  // not a refusal. Both are refused here, before any filesystem access.
  it('rejects a name whose derived kebab carries a control character', () => {
    for (const input of ['a\u0000b', 'ok\u0000', '\u007fx']) {
      expect(isIdentifierSafe(deriveNames(input))).toBe(false);
    }
  });

  // `\` is a path separator on Windows, and Deno honours it there, so
  // `..\sibling` escapes the target directory exactly as `../sibling` does on
  // every platform. A C1 control (U+0085, NEL) is a line break to several
  // terminals, so the control-character rule covers the whole Cc category.
  it('rejects a Windows path separator and a C1 control character', () => {
    for (const input of ['..\\sibling', 'a\\b', 'a\u0085b', 'a\u009fb']) {
      expect(isIdentifierSafe(deriveNames(input))).toBe(false);
      expect(isPathSegmentSafe(deriveNames(input))).toBe(false);
    }
  });

  it('rejects a name longer than a filesystem filename component', () => {
    expect(isIdentifierSafe(deriveNames('a'.repeat(256)))).toBe(false);
    expect(isIdentifierSafe(deriveNames('a'.repeat(255)))).toBe(true);
  });
});

describe('escapeName', () => {
  it('renders control characters as escapes so a refusal stays one line', () => {
    expect(escapeName('../sib\r\nINJECTED: scaffold complete')).toBe(
      '../sib\\u000d\\u000aINJECTED: scaffold complete',
    );
    expect(escapeName('a\u0000b')).toBe('a\\u0000b');
  });

  it('leaves an ordinary name verbatim', () => {
    expect(escapeName('user-profile')).toBe('user-profile');
  });
});

// The project directory is a path segment and never an identifier, so `new`
// takes only the path rules. On `main` before M99e, `setu new 3d-shop` and
// `setu new 2048` scaffolded; the shared identifier guard silently refused both.
describe('isPathSegmentSafe', () => {
  it('accepts a digit-leading or letterless segment the identifier rule refuses', () => {
    for (const input of ['3d-shop', '2048', 'oauth2-client', 'shop']) {
      expect(isPathSegmentSafe(deriveNames(input))).toBe(true);
    }
  });

  it('rejects the empty, current and parent segments', () => {
    for (const input of ['', '___', '.', '..', './']) {
      expect(isPathSegmentSafe(deriveNames(input))).toBe(false);
    }
  });

  it('rejects separators, control characters and over-long segments', () => {
    for (const input of ['../sibling', 'a/b', 'a\\b', 'a\u0000b', 'a'.repeat(256)]) {
      expect(isPathSegmentSafe(deriveNames(input))).toBe(false);
    }
    expect(isPathSegmentSafe(deriveNames('a'.repeat(255)))).toBe(true);
  });
});
