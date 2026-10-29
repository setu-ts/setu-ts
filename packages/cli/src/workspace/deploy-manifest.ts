/**
 * Turns the generated `k8s/members.yaml` into what `setu workspace deploy` applies (M122 §3.8).
 *
 * The file ON DISK is applied, not a fresh render, because the generated `k8s/README.md` tells
 * developers to edit probe paths there. Deploy fills the two placeholders and points each member's
 * `image:` line at the image it just built — in the manifest, rather than with `kubectl set
 * image` afterwards, which would roll every Deployment out a second time. Anything it cannot do
 * with certainty is refused before an image is built.
 *
 * @module
 */

import { memberSecretName, SECRET_VERSION_ANNOTATION } from './secrets.ts';

/** What preparing the manifest produced. */
export type DeployManifestResult =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

/** The inputs the manifest is filled from. */
export interface DeployManifestInputs {
  /**
   * Written into every `${NAMESPACE}` placeholder. An object in the file that names its own
   * namespace, or a cluster-scoped kind, applies as written: the file is the workspace's own.
   */
  readonly namespace: string;
  /** The workspace name, for the `part-of` labels. */
  readonly workspace: string;
  /** Each member's built image reference, keyed by member name, in manifest order. */
  readonly images: ReadonlyMap<string, string>;
}

/** Escapes a member name for use inside a regular expression. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fills the generated manifest for one deploy.
 *
 * @param text - `k8s/members.yaml` as it is on disk
 * @param inputs - Namespace, workspace name and images
 * @returns The manifest to apply, or the reason it cannot be applied as-is
 */
export function prepareDeployManifest(
  text: string,
  inputs: DeployManifestInputs,
): DeployManifestResult {
  let filled = text
    .replaceAll('${NAMESPACE}', inputs.namespace)
    .replaceAll('${WORKSPACE}', inputs.workspace);
  for (const [member, image] of inputs.images) {
    // The line the generator writes: `image: <member>:dev`, nothing after it.
    // `[ \t]*`, never `\s*`: `\s` spans newlines, and a hostile file of blank lines then
    // backtracks quadratically (M122 re-audit N3: 40k newlines took 0.8 s).
    const line = new RegExp(`^([ \\t]*image:[ \\t]*)${literal(member)}:dev[ \\t]*$`, 'gm');
    const matches = [...filled.matchAll(line)].length;
    if (matches !== 1) {
      return {
        ok: false,
        message:
          `k8s/members.yaml has ${matches === 0 ? 'no' : matches} \`image: ${member}:dev\` line` +
          `${matches === 0 ? '' : 's'}, so deploy cannot tell which image to point at. Restore ` +
          `the generated line for ${member}, or apply that member by hand.`,
      };
    }
    filled = filled.replace(line, (_whole, lead: string) => `${lead}${image}`);
  }
  const leftover = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.exec(filled);
  if (leftover !== null) {
    return {
      ok: false,
      message: `k8s/members.yaml still contains ${leftover[0]} after filling NAMESPACE and WORKSPACE; replace it before deploying.`,
    };
  }
  return { ok: true, text: filled };
}

/**
 * Whether a member's Deployment reads its Secret.
 *
 * A workspace's `members.yaml` written before M122 has no `envFrom`, and only `generate app`,
 * `adopt` and `workspace ports --reallocate` regenerate it; applying a Secret nothing reads would
 * leave the member crashing on its first required variable.
 *
 * @param text - `k8s/members.yaml`
 * @param member - The member
 * @returns Whether a `secretRef` names `<member>-env`
 */
export function readsMemberSecret(text: string, member: string): boolean {
  const name = literal(memberSecretName(member));
  return new RegExp(`secretRef:[ \\t]*\\n[ \\t]*name:[ \\t]*['"]?${name}['"]?[ \\t]*$`, 'm').test(
    text,
  );
}

/**
 * Writes a member's Secret version into its Deployment's pod-template annotation.
 *
 * Strict, because a misplaced stamp is silent: the rotation would never roll out (audit 3, L2).
 * The document separator may carry a comment (`--- # x`); exactly one document must be a
 * Deployment whose top-level `metadata.name` is the member, and it must hold exactly one slot at
 * the pod template's annotation indent (8 spaces, as generated). Anything else — no slot, two
 * owning documents, two slots — is reported as not stamped, and the caller falls back to
 * `kubectl rollout restart`.
 *
 * @param text - The manifest being applied
 * @param member - The member
 * @param version - The Secret's `resourceVersion`, already validated
 * @returns The manifest with the slot filled, and whether exactly one slot was filled
 */
export function stampSecretVersion(
  text: string,
  member: string,
  version: string,
): { readonly text: string; readonly stamped: boolean } {
  const separator = /^---(?:[ \t]+#[^\n]*)?[ \t]*$/gm;
  const pieces: string[] = [];
  const separators: string[] = [];
  let last = 0;
  for (const match of text.matchAll(separator)) {
    pieces.push(text.slice(last, match.index));
    separators.push(match[0]);
    last = match.index + match[0].length;
  }
  pieces.push(text.slice(last));
  const own = new RegExp(`^  name:[ \\t]*${literal(member)}[ \\t]*$`, 'm');
  const slot = new RegExp(`^( {8}${literal(SECRET_VERSION_ANNOTATION)}:[ \\t]*).*$`, 'gm');
  const owners = pieces
    .map((document, index) => ({ document, index }))
    .filter(
      ({ document }) => /^kind:[ \t]*Deployment[ \t]*$/m.test(document) && own.test(document),
    );
  if (owners.length !== 1) return { text, stamped: false };
  const owner = owners[0]!;
  if ([...owner.document.matchAll(slot)].length !== 1) return { text, stamped: false };
  pieces[owner.index] = owner.document.replace(
    slot,
    (_line, lead: string) => `${lead}'${version}'`,
  );
  return {
    text: pieces.map((piece, index) => piece + (separators[index] ?? '')).join(''),
    stamped: true,
  };
}
