/**
 * Member secrets for `setu workspace deploy` (M122 §3.4).
 *
 * The NAMES a member needs are its committed `.env.example`'s keys, minus everything the generated
 * manifest already sets for it (sibling hosts, the transport URL). The VALUES come from an
 * operator file, `k8s/secrets/<member>/.env`, which the `.env` ignore rule of every workspace root
 * keeps out of git and the generated `.dockerignore` keeps out of every image. Both files are read
 * with the same `parseEnv` the application's config plugin uses, so a value means in the cluster
 * what it means locally.
 *
 * The Secret carries its values base64-encoded under `data:` and is applied server-side; see
 * {@linkcode renderMemberSecret} for why each half matters.
 *
 * @module
 */

import { parseEnv } from '@setu-ts/common';

/**
 * Where an operator keeps one member's values, relative to the workspace root.
 *
 * @param member - The member
 * @returns The path; a file named `.env`, so existing roots' ignore rule already covers it
 */
export function secretValuesPath(member: string): string {
  return `k8s/secrets/${member}/.env`;
}

/**
 * The Secret a member's Deployment reads through `envFrom`.
 *
 * @param member - The member
 * @returns `<member>-env`
 */
export function memberSecretName(member: string): string {
  return `${member}-env`;
}

/**
 * The container's `envFrom` block reading the member's Secret.
 *
 * Rendered into every generated Deployment, and printed by `deploy` when a pre-M122 manifest lacks
 * it. `optional: true` lets a member with no secrets start; explicit `env:` entries still win over
 * it (Kubernetes' rule), so the Secret cannot override a generated sibling host.
 *
 * @param member - The member
 * @returns The block, indented for a container in the generated manifest
 */
export function envFromBlock(member: string): string {
  return `          envFrom:
            - secretRef:
                name: ${memberSecretName(member)}
                optional: true`;
}

/**
 * The names a member's environment declares that the generated manifest does not already set.
 *
 * @param example - The member's `.env.example` contents
 * @param generated - The names the generated `env:` sets for this member
 * @returns The declared names, in file order
 * @throws {Error} When the example file is not valid dotenv (the parser's message)
 */
export function declaredSecretNames(
  example: string,
  generated: ReadonlySet<string>,
): readonly string[] {
  return Object.keys(parseEnv(example)).filter((name) => !generated.has(name));
}

/**
 * The declared names an operator file has no entry for. An empty value is an entry.
 *
 * @param declared - The declared names
 * @param values - The operator file's parsed values
 * @returns The missing names, in declaration order
 */
export function missingSecretNames(
  declared: readonly string[],
  values: Readonly<Record<string, string>>,
): readonly string[] {
  return declared.filter((name) => !Object.hasOwn(values, name));
}

/**
 * Base64 of a string's UTF-8 bytes, as Kubernetes expects under a Secret's `data:`.
 *
 * @param value - The value
 * @returns Its base64 encoding
 */
export function base64Utf8(value: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Renders one member's Secret.
 *
 * Under `data:`, base64-encoded, and meant for `kubectl apply --server-side`. Measured on kind
 * (M122 §1): a client-side apply stores every value in plaintext in the
 * `last-applied-configuration` annotation, and `stringData` under a server-side apply keeps keys
 * the file no longer has. Base64 also means no value needs YAML quoting.
 *
 * @param member - The member
 * @param namespace - The namespace it deploys into
 * @param workspace - The workspace name, for the `part-of` label
 * @param values - Every value in the operator file
 * @returns The Secret manifest
 */
export function renderMemberSecret(
  member: string,
  namespace: string,
  workspace: string,
  values: Readonly<Record<string, string>>,
): string {
  const entries = Object.entries(values);
  const data =
    entries.length === 0
      ? 'data: {}'
      : `data:\n${entries
          // An empty value is `''`: a bare `KEY:` is YAML null, not an empty string.
          .map(([key, value]) => `  ${key}: ${value === '' ? "''" : base64Utf8(value)}`)
          .join('\n')}`;
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${memberSecretName(member)}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: ${member}
    app.kubernetes.io/part-of: ${workspace}
    app.kubernetes.io/managed-by: setu
type: Opaque
${data}
`;
}
