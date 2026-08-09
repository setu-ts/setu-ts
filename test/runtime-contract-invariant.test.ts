/**
 * Exact contract invariant test preventing the IRuntimeServices guide contract
 * from drifting silently against the actual exported interface in common.
 *
 * Parses the real TypeScript interface declaration from the source and compares
 * it exactly against the documented interface block. Rejects missing members,
 * changed signatures, optionality modifications, and extra documented members.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

/**
 * Parse TypeScript interface members from source text.
 * Extracts method signatures and property declarations from an interface block,
 * normalizing whitespace for exact comparison.
 */
function parseInterfaceMembers(source: string, interfaceName: string): Map<string, string> {
  const members = new Map<string, string>();

  // Find the interface declaration - handle the braces properly
  const startMarker = `export interface ${interfaceName} {`;
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`Interface "${interfaceName}" not found in source`);
  }

  // Find the closing brace (counting nesting)
  let depth = 0;
  let bodyEnd = -1;
  for (let i = startIdx + startMarker.length; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
      depth--;
    }
  }
  if (bodyEnd === -1) {
    throw new Error(`Cannot find closing brace for interface "${interfaceName}"`);
  }

  const body = source.slice(startIdx + startMarker.length, bodyEnd);
  const lines = body.split('\n');

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/**')) continue;

    // Extract the member name (first identifier before : or () or ?)
    const nameMatch = line.match(/^\s*(readonly\s+)?(\w+)(\??)\s*[(:]/);
    if (!nameMatch) continue;

    const name = nameMatch[2];
    // Normalize: collapse whitespace, preserve signature structure
    const normalized = line.replace(/\s+/g, ' ').trim();
    members.set(name, normalized);
  }

  return members;
}

describe('IRuntimeServices contract invariant', () => {
  it('documented IRuntimeServices matches exported interface exactly', async () => {
    // Read the actual exported interface.
    const source = await Deno.readTextFile('packages/common/src/runtime.ts');
    const actualMembers = parseInterfaceMembers(source, 'IRuntimeServices');

    // Read the documented interface block from programmatic-api.md.
    const doc = await Deno.readTextFile('docs/programmatic-api.md');

    // Extract the IRuntimeServices section (between the heading and the next heading).
    const runtimeSectionStart = doc.indexOf('### IRuntimeServices');
    expect(runtimeSectionStart).toBeGreaterThan(-1);

    const runtimeSectionEnd = doc.indexOf('\n## ', runtimeSectionStart + 1);
    const runtimeSection = runtimeSectionEnd > 0
      ? doc.slice(runtimeSectionStart, runtimeSectionEnd)
      : doc.slice(runtimeSectionStart);

    // Parse the documented interface block (```typescript ... ```)
    const fenceMatch = runtimeSection.match(/```typescript\s*\n([\s\S]*?)```/);
    if (!fenceMatch) {
      throw new Error('No TypeScript fence found in IRuntimeServices documentation section');
    }

    const docInterfaceBlock = fenceMatch[1];
    const docMembers = parseInterfaceMembers(
      `export interface IRuntimeServices {\n${docInterfaceBlock}\n}`,
      'IRuntimeServices',
    );

    // Exact comparison: every actual member must be documented
    for (const [name, actualSignature] of actualMembers) {
      if (!docMembers.has(name)) {
        throw new Error(
          `Missing documented member: '${name}' exists on IRuntimeServices but is not documented`,
        );
      }
      const docSignature = docMembers.get(name)!;
      // Compare normalized signatures (allow whitespace differences but catch signature changes)
      const actualNorm = actualSignature
        .replace(/\s+/g, ' ')
        .replace(/readonly\s+/g, 'readonly ')
        .trim();
      const docNorm = docSignature
        .replace(/\s+/g, ' ')
        .replace(/readonly\s+/g, 'readonly ')
        .trim();
      if (actualNorm !== docNorm) {
        throw new Error(
          `Signature mismatch for '${name}':\n` +
            `  actual: ${actualNorm}\n` +
            `  doc:    ${docNorm}`,
        );
      }
    }

    // No extra documented members (prevents stale documentation)
    for (const name of docMembers.keys()) {
      if (!actualMembers.has(name)) {
        throw new Error(
          `Extra documented member: '${name}' is in docs but not on IRuntimeServices`,
        );
      }
    }

    // Verify optionality is preserved (readonly vs mutable, required vs optional)
    for (const [name, actualSignature] of actualMembers) {
      const isOptional = actualSignature.includes('?');
      const docSig = docMembers.get(name)!;
      const docIsOptional = docSig.includes('?');
      if (isOptional !== docIsOptional) {
        throw new Error(
          `Optionality mismatch for '${name}': actual is ` +
            `${isOptional ? 'optional' : 'required'}, doc says ` +
            `${docIsOptional ? 'optional' : 'required'}`,
        );
      }
    }
  });
});
