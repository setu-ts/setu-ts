import { describe, expect, it } from 'vitest';

import { maskComments } from '../../../src/devtool/sources.ts';
import { afterLastImport } from '../../../src/utils/import-placement.ts';

function at(source: string): number | undefined {
  return afterLastImport(source, maskComments(source)!);
}

describe('afterLastImport', () => {
  it('places a new import after the last complete import statement', () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['no imports', 'export const a = 1;\n', ''],
      [
        'one import',
        "import { a } from './a.ts';\nexport const b = a;\n",
        "import { a } from './a.ts';",
      ],
      [
        'a multi-line last import',
        "import {\n  a,\n  b,\n} from './a.ts';\nexport const c = a + b;\n",
        "import {\n  a,\n  b,\n} from './a.ts';",
      ],
      [
        'a last side-effect import with a comment',
        "import { a } from './a.ts';\nimport './setup.ts'; // setup\nexport const b = a;\n",
        "import { a } from './a.ts';\nimport './setup.ts'; // setup",
      ],
      [
        'an import on the last line with no newline',
        "import { a } from './a.ts';",
        "import { a } from './a.ts';",
      ],
      [
        'an import commented out after the real one',
        "import { a } from './a.ts';\n// import { b } from './b.ts';\nexport const c = a;\n",
        "import { a } from './a.ts';",
      ],
    ];
    for (const [label, source, before] of cases) expect(at(source), label).toBe(before.length);
  });

  it('declines a last import whose specifier is not on the clause line', () => {
    expect(at("import { a } from\n  './a.ts';\nexport const b = a;\n")).toBeUndefined();
  });
});
