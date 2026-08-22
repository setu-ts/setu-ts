/**
 * Unit tests for the raw-SQL placeholder binder.
 *
 * The scanner decides only WHERE to cut a statement; the values are always
 * bound, never interpolated, so a mis-scan can never become an injection. It
 * can produce a wrong binding, which is why every disagreement between the
 * statement and the parameter list is a refusal rather than a guess.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { bindRawStatement, type RawStatementTag } from '../../src/query/raw-statement.ts';

/** A tag that records what the binder built, in reading order. */
const tag: RawStatementTag = {
  raw: (text) => ({ raw: text }),
  param: (value) => ({ param: value }),
};

/** Re-render the chunk list as `<text>` with each bound value spelled `⟦value⟧`. */
function render(chunks: readonly unknown[]): string {
  return chunks
    .map((chunk) => {
      const entry = chunk as { raw?: string; param?: unknown };
      return 'raw' in entry ? entry.raw : `⟦${JSON.stringify(entry.param)}⟧`;
    })
    .join('');
}

describe('bindRawStatement', () => {
  describe('with no parameters', () => {
    it('passes the statement through as one literal chunk', () => {
      const chunks = bindRawStatement('select 1 as n', [], tag);
      expect(chunks).toEqual([{ raw: 'select 1 as n' }]);
    });

    it('leaves placeholder-looking text untouched, exactly as Prisma and D1 do', () => {
      // Prisma's `$queryRawUnsafe(sql)` and D1's `prepare(sql)` both forward
      // the text verbatim and let the database report the unbound placeholder.
      const chunks = bindRawStatement('select * from t where a = $1', [], tag);
      expect(chunks).toEqual([{ raw: 'select * from t where a = $1' }]);
    });
  });

  describe('positional ? placeholders', () => {
    it('splits at each token and binds in order', () => {
      const chunks = bindRawStatement('select * from t where a = ? and b = ?', ['x', 2], tag);
      expect(render(chunks)).toBe('select * from t where a = ⟦"x"⟧ and b = ⟦2⟧');
    });

    it('binds a trailing placeholder with an empty tail chunk', () => {
      const chunks = bindRawStatement('select ?', [7], tag);
      expect(render(chunks)).toBe('select ⟦7⟧');
    });
  });

  describe('numbered $N placeholders', () => {
    it('binds each token to the parameter it names', () => {
      const chunks = bindRawStatement('select * from t where a = $1 and b = $2', ['x', 2], tag);
      expect(render(chunks)).toBe('select * from t where a = ⟦"x"⟧ and b = ⟦2⟧');
    });

    it('honours a repeated reference, binding the same value twice', () => {
      // PostgreSQL allows `$1` twice with one parameter. Drizzle renumbers
      // chunks, so the emitted text becomes `$1 … $2` with the value repeated —
      // a different statement, an identical result.
      const chunks = bindRawStatement('select * from t where a = $1 or b = $1', ['x'], tag);
      expect(render(chunks)).toBe('select * from t where a = ⟦"x"⟧ or b = ⟦"x"⟧');
    });

    it('binds out-of-order references to the parameters they name', () => {
      const chunks = bindRawStatement('select $2, $1', ['first', 'second'], tag);
      expect(render(chunks)).toBe('select ⟦"second"⟧, ⟦"first"⟧');
    });

    it('reads a multi-digit reference as one number', () => {
      const params = Array.from({ length: 12 }, (_, index) => index + 1);
      const statement = params.map((n) => `$${n}`).join(',');
      const chunks = bindRawStatement(statement, params, tag);
      expect(render(chunks)).toBe(params.map((n) => `⟦${n}⟧`).join(','));
    });
  });

  describe('regions where a placeholder cannot occur', () => {
    it('ignores a ? inside a single-quoted string', () => {
      const chunks = bindRawStatement("select * from t where a = 'why?' and b = ?", [1], tag);
      expect(render(chunks)).toBe("select * from t where a = 'why?' and b = ⟦1⟧");
    });

    it('honours the doubled-quote escape inside a string literal', () => {
      const chunks = bindRawStatement("select 'it''s ?' , ?", [1], tag);
      expect(render(chunks)).toBe("select 'it''s ?' , ⟦1⟧");
    });

    it('ignores a ? inside a double-quoted identifier', () => {
      const chunks = bindRawStatement('select "odd?col" from t where a = ?', [1], tag);
      expect(render(chunks)).toBe('select "odd?col" from t where a = ⟦1⟧');
    });

    it('honours the doubled-quote escape inside a quoted identifier', () => {
      const chunks = bindRawStatement('select "a""?b" , ?', [1], tag);
      expect(render(chunks)).toBe('select "a""?b" , ⟦1⟧');
    });

    it('ignores a ? inside a MySQL backtick identifier', () => {
      const chunks = bindRawStatement('select `odd?col` from t where a = ?', [1], tag);
      expect(render(chunks)).toBe('select `odd?col` from t where a = ⟦1⟧');
    });

    it('ignores a ? inside a line comment', () => {
      const chunks = bindRawStatement('select 1 -- what?\nwhere a = ?', [1], tag);
      expect(render(chunks)).toBe('select 1 -- what?\nwhere a = ⟦1⟧');
    });

    it('ignores a ? inside an unterminated line comment', () => {
      const chunks = bindRawStatement('select ? -- trailing?', [1], tag);
      expect(render(chunks)).toBe('select ⟦1⟧ -- trailing?');
    });

    it('ignores a ? inside a block comment', () => {
      const chunks = bindRawStatement('select /* what? */ ?', [1], tag);
      expect(render(chunks)).toBe('select /* what? */ ⟦1⟧');
    });

    it('honours PostgreSQL nested block comments', () => {
      const chunks = bindRawStatement('select /* a /* ? */ ? */ ?', [1], tag);
      expect(render(chunks)).toBe('select /* a /* ? */ ? */ ⟦1⟧');
    });

    it('treats an unterminated block comment as running to the end', () => {
      const chunks = bindRawStatement('select ? /* never closed ?', [1], tag);
      expect(render(chunks)).toBe('select ⟦1⟧ /* never closed ?');
    });

    it('ignores placeholders inside a PostgreSQL dollar-quoted body', () => {
      const chunks = bindRawStatement('select $tag$ ? and $1 $tag$, ?', [1], tag);
      expect(render(chunks)).toBe('select $tag$ ? and $1 $tag$, ⟦1⟧');
    });

    it('does not mistake arithmetic minus for a line comment', () => {
      const chunks = bindRawStatement('select qty - ? from t', [1], tag);
      expect(render(chunks)).toBe('select qty - ⟦1⟧ from t');
    });

    it('does not mistake division for a block comment', () => {
      const chunks = bindRawStatement('select qty / ? from t', [2], tag);
      expect(render(chunks)).toBe('select qty / ⟦2⟧ from t');
    });

    it('accepts an uppercase dollar-quote tag', () => {
      const chunks = bindRawStatement('select $BODY$ ? $BODY$, ?', [1], tag);
      expect(render(chunks)).toBe('select $BODY$ ? $BODY$, ⟦1⟧');
    });

    it('accepts an underscore-leading dollar-quote tag', () => {
      const chunks = bindRawStatement('select $_t$ ? $_t$, ?', [1], tag);
      expect(render(chunks)).toBe('select $_t$ ? $_t$, ⟦1⟧');
    });

    it('accepts digits inside a dollar-quote tag after its first character', () => {
      // `$1` is a placeholder and `$t1$` is a tag, which is exactly why a digit
      // is allowed everywhere in the tag except its first character.
      const chunks = bindRawStatement('select $t1$ ? $t1$, ?', [1], tag);
      expect(render(chunks)).toBe('select $t1$ ? $t1$, ⟦1⟧');
    });

    it('ignores placeholders inside an anonymous dollar-quoted body', () => {
      const chunks = bindRawStatement('select $$ ? $$, ?', [1], tag);
      expect(render(chunks)).toBe('select $$ ? $$, ⟦1⟧');
    });

    it('treats an unterminated dollar quote as running to the end', () => {
      const chunks = bindRawStatement('select ?, $tag$ never closed', [1], tag);
      expect(render(chunks)).toBe('select ⟦1⟧, $tag$ never closed');
    });

    it('does not mistake a lone $ for a placeholder or a dollar quote', () => {
      const chunks = bindRawStatement("select '$' || ?", [1], tag);
      expect(render(chunks)).toBe("select '$' || ⟦1⟧");
    });

    it('does not mistake a trailing $ at end of statement for a token', () => {
      const chunks = bindRawStatement('select ?, cast(x as text) $', [1], tag);
      expect(render(chunks)).toBe('select ⟦1⟧, cast(x as text) $');
    });

    it('does not mistake a PostgreSQL cast for a placeholder', () => {
      const chunks = bindRawStatement('select $1::text', ['x'], tag);
      expect(render(chunks)).toBe('select ⟦"x"⟧::text');
    });

    it('treats an unterminated string literal as running to the end', () => {
      // The `?` before the quote is a real placeholder; everything from the
      // quote onwards is literal, so the second `?` is not counted.
      const chunks = bindRawStatement("select ? , 'never closed ?", [1], tag);
      expect(render(chunks)).toBe("select ⟦1⟧ , 'never closed ?");
    });
  });

  describe('refusals', () => {
    it('refuses parameters when the statement has no placeholder', () => {
      expect(() => bindRawStatement('select 1', [1], tag)).toThrow(
        'Raw query received 1 parameter(s) but the statement has no',
      );
    });

    it('refuses a ? count that disagrees with the parameter count', () => {
      expect(() => bindRawStatement('select ?, ?', [1], tag)).toThrow(
        "Raw query has 2 '?' placeholder(s) but received 1 parameter(s)",
      );
    });

    it('refuses a highest $N that disagrees with the parameter count', () => {
      expect(() => bindRawStatement('select $1, $2', [1], tag)).toThrow(
        'Raw query references up to $2 but received 1 parameter(s)',
      );
    });

    it('refuses a gap in the $N sequence, naming the dropped parameter', () => {
      expect(() => bindRawStatement('select $1, $3', [1, 2, 3], tag)).toThrow(
        'Raw query never references $2, so parameter 2 would be dropped',
      );
    });

    it('refuses a statement mixing both placeholder styles', () => {
      expect(() => bindRawStatement('select $1, ?', [1, 2], tag)).toThrow(
        "Raw query mixes '?' and '$N' placeholders in one statement",
      );
    });

    it('never puts a parameter value into a refusal message', () => {
      let message = '';
      try {
        bindRawStatement('select 1', ['super-secret-token'], tag);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toContain('super-secret-token');
    });
  });
});
