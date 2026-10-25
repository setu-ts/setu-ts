/**
 * A worked functional example for the default REST template.
 *
 * The example is registered through its module index and reaches its plain
 * service by a direct import, exactly as the functional generators do.
 *
 * @module
 */
import type { GeneratedFile } from '../utils/file-writer.ts';
import { routeRegistrarSymbol } from '../seams/http.ts';
import { deriveNames } from '../utils/names.ts';
import { generateModule } from '../schematics/module.ts';
import type { TargetRuntime } from '../constants.ts';
import { renderEquals, testHarnessFor } from '../schematics/test-harness.ts';

/** The artifact name shared by the greeting controller and service. */
export const REST_SHOWCASE = 'greeting';

const NAMES = deriveNames(REST_SHOWCASE);
const SERVICE = 'greet';
const REGISTER = routeRegistrarSymbol(NAMES);

const SERVICE_SOURCE = `/**
 * Builds a greeting for one name.
 *
 * @param name - The name to greet
 * @returns A greeting message
 */
export function ${SERVICE}(name: string): string {
  return \`Hello, \${name}!\`;
}
`;

const CONTROLLER_SOURCE = `import type { IRouterApi, IServiceRegistry } from '@setu-ts/common';

import { ${SERVICE} } from './${NAMES.kebab}.service.ts';

/**
 * Registers the greeting routes.
 *
 * @param router - The application router
 */
export function ${REGISTER}(router: IRouterApi, services?: IServiceRegistry): void {
  void services;
  router.group('/greetings', (routes) => {
    routes.get('/', (ctx) => ctx.response.json({ message: ${SERVICE}('world') }));
    routes.get(
      '/:name',
      (ctx) => ctx.response.json({ message: ${SERVICE}(ctx.params.name ?? 'world') }),
    );
  });
}
`;

/** The functional service and controller source emitted by the REST template. */
export const REST_SHOWCASE_FILES: readonly GeneratedFile[] =
  restShowcaseFiles('cloudflare-workers');

/** Renders the showcase through the module renderer with greeting-specific bodies and tests. */
export function restShowcaseFiles(runtime: TargetRuntime): readonly GeneratedFile[] {
  return generateModule(NAMES, {
    runtime,
    plugins: new Set(),
  })
    .filter(
      (file) => file.path !== 'src/modules/index.ts' && file.path !== 'test/support/server.ts',
    )
    .map((file) => ({
      ...file,
      contents: file.path.endsWith('.service.ts')
        ? SERVICE_SOURCE
        : file.path.endsWith('.routes.ts')
          ? CONTROLLER_SOURCE
          : file.path.endsWith('.e2e.test.ts')
            ? `${testHarnessFor(runtime).imports}
import { startTestServer } from '../../../test/support/server.ts';

describe('greeting e2e', () => {
  it('greets through HTTP', async () => {
    const server = await startTestServer();
    try {
      for (
        const [path, message] of [['/greetings', 'Hello, world!'], [
          '/greetings/ada',
          'Hello, ada!',
        ]]
      ) {
        const response = await fetch(server.baseUrl + path);
        ${renderEquals(runtime, 'response.status', '200')}
        ${renderEquals(runtime, 'await response.json()', '{ message }')}
      }
    } finally {
      await server.stop();
    }
  });
});
`
            : file.path.endsWith('.test.ts')
              ? runtime === 'cloudflare-workers'
                ? `${testHarnessFor(runtime).imports}
import { startTestServer } from '../../../test/support/server.ts';

describe('greeting module', () => {
  it('greets through the Worker routes', async () => {
    const server = await startTestServer();
    try {
      for (
        const [path, message] of [['/greetings', 'Hello, world!'], [
          '/greetings/ada',
          'Hello, ada!',
        ]]
      ) {
        const response = await fetch(server.baseUrl + path);
        ${renderEquals(runtime, 'response.status', '200')}
        ${renderEquals(runtime, 'await response.json()', '{ message }')}
      }
    } finally {
      await server.stop();
    }
  });
});
`
                : `${testHarnessFor(runtime).imports}
import { createTestApp } from '@setu-ts/testing';
import { createApp } from '../../../setu.config.ts';

describe('greeting module', () => {
  it('greets through the application routes', async () => {
    const app = await createTestApp({ app: await createApp() });
    try {
      for (
        const [path, message] of [['/greetings', 'Hello, world!'], [
          '/greetings/ada',
          'Hello, ada!',
        ]]
      ) {
        const response = await app.inject({ method: 'GET', url: path });
        ${renderEquals(runtime, 'response.statusCode', '200')}
        ${renderEquals(runtime, 'response.json()', '{ message }')}
      }
    } finally {
      await app.stop();
    }
  });
});
`
              : file.contents,
    }));
}
