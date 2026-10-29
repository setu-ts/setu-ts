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

import { memberSecretName } from './secrets.ts';

/** What preparing the manifest produced. */
export type DeployManifestResult =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

/** The inputs the manifest is filled from. */
export interface DeployManifestInputs {
  /** The namespace every object is pinned to. */
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
    const line = new RegExp(`^(\\s*image:\\s*)${literal(member)}:dev[ \\t]*$`, 'gm');
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
  return new RegExp(`secretRef:\\s*\\n\\s*name:\\s*['"]?${name}['"]?\\s*$`, 'm').test(text);
}
