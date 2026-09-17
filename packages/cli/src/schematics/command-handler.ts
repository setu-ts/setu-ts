/**
 * CQRS command handler schematic (gated on `cqrs-plugin`).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { COMMAND_HANDLER_SEAM, COMMAND_HANDLERS_EXPORT } from '../seams/cqrs.ts';
import { INGRESS_SEAM } from '../seams/ingress.ts';
import { seamNames } from '../seams/seam-spec.ts';
import { generatorMode } from '../utils/generator-mode.ts';
import {
  renderConstAssignment,
  renderDeclarationHeader,
  renderMethodSignature,
} from '../utils/render-declaration.ts';

/**
 * Generates a command and its handler, and regenerates the seam barrel.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Supplies the handlers already present, for the barrel
 * @returns The handler at `src/cqrs/<kebab>.command-handler.ts`, plus the managed
 *   `src/cqrs/index.ts` barrel, which lists query handlers too
 */
export function generateCommandHandler(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  if (generatorMode(options.plugins) === 'class-based') {
    return [
      {
        path: `${INGRESS_SEAM.dir}/${names.kebab}${INGRESS_SEAM.suffix}`,
        contents: `import type { CqrsCommand } from '@setu-ts/common';
import { CommandHandler } from '@setu-ts/decorator-plugin';

/** Type name the command bus routes on. */
${renderConstAssignment(`${names.screaming}_COMMAND`, `'${names.pascal}'`)}

/** Payload of the ${names.pascal} command. */
export interface ${names.pascal}Payload {
  readonly id: string;
}

/** The ${names.pascal} command. */
export interface ${names.pascal}Command extends CqrsCommand<${names.pascal}Payload> {
  readonly type: typeof ${names.screaming}_COMMAND;
}

/** Decorated command handler, registered through the ingress barrel. */
export class ${names.pascal}Ingress {
  @CommandHandler(${names.screaming}_COMMAND)
  handle(command: ${names.pascal}Command): Promise<{ readonly id: string }> {
    return Promise.resolve({ id: command.data.id });
  }
}
`,
      },
      {
        path: INGRESS_SEAM.barrel,
        contents: INGRESS_SEAM.renderBarrel({
          ingress: seamNames(options.artifacts, 'ingress', names.kebab),
        }),
        managed: true,
      },
    ];
  }
  const contents = `import type { CqrsCommand, ICommandHandler } from '@setu-ts/common';

/** Type name the command bus routes on. */
${renderConstAssignment(`${names.screaming}_COMMAND`, `'${names.pascal}'`)}

/** Payload of the ${names.pascal} command. */
export interface ${names.pascal}Payload {
  /** Replace with the command's real payload. */
  readonly id: string;
}

/** Result the ${names.pascal} handler returns. */
export interface ${names.pascal}Result {
  /** Replace with the command's real result. */
  readonly id: string;
}

/** The ${names.pascal} command. */
${
    renderDeclarationHeader(
      `export interface ${names.pascal}Command`,
      `extends CqrsCommand<${names.pascal}Payload>`,
    )
  }
  readonly type: typeof ${names.screaming}_COMMAND;
}

/**
 * Handles {@linkcode ${names.pascal}Command}.
 *
 * Registered through the \`${COMMAND_HANDLERS_EXPORT}\` barrel in \`src/cqrs/index.ts\`,
 * which \`setu.config.ts\` passes to \`CqrsPlugin\` — so this class needs no further
 * wiring, and \`commandBus.execute({ type: ${names.screaming}_COMMAND, … })\` reaches it.
 * The barrel references the factory below by name, so the factory is the single
 * construction site.
 */
${
    renderDeclarationHeader(
      `export class ${names.pascal}CommandHandler`,
      `implements ICommandHandler<${names.pascal}Command, ${names.pascal}Result>`,
    )
  }
  /**
   * Executes the command.
   *
   * @param command - The command to handle
   * @returns The command result
   */
${
    renderMethodSignature(
      'handle',
      [`command: ${names.pascal}Command`],
      `Promise<${names.pascal}Result>`,
    )
  }
    // Replace with the real write.
    return Promise.resolve({ id: command.data.id });
  }
}

/**
 * Builds the handler. The barrel references this factory by name, so it is the
 * single construction site — and the place to wire a dependency in.
 * \`CqrsPluginOptions.commandHandlers\` accepts a factory that builds a handler
 * from the service registry, called at the \`onInit\` phase, after every plugin
 * has registered, so to take a dependency change the one line to:
 *
 * \`\`\`ts
 * export function create${names.pascal}CommandHandler(services: IServiceRegistry): ${names.pascal}CommandHandler {
 *   // resolve a capability from services and build with it
 * }
 * \`\`\`
 */
export function create${names.pascal}CommandHandler(): ${names.pascal}CommandHandler {
  return new ${names.pascal}CommandHandler();
}
`;
  return [
    { path: `src/cqrs/${names.kebab}.command-handler.ts`, contents },
    {
      path: COMMAND_HANDLER_SEAM.barrel,
      // Both kinds are passed: the barrel lists commands AND queries, so generating a
      // command handler must not drop a query handler already present.
      contents: COMMAND_HANDLER_SEAM.renderBarrel({
        'command-handler': seamNames(options.artifacts, 'command-handler', names.kebab),
        'query-handler': seamNames(options.artifacts, 'query-handler'),
      }),
      managed: true,
    },
  ];
}
