import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startTestServer } from '../support/server.ts';

describe('chat page e2e', () => {
  it('serves the page and its script, and keeps both out of the OpenAPI document', async () => {
    const server = await startTestServer();
    try {
      const page = await fetch(server.baseUrl + '/ui');
      assert.deepStrictEqual(page.status, 200);
      assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
      assert.match(await page.text(), /<script type="module" src="\/ui\/chat\.js"><\/script>/);

      const script = await fetch(server.baseUrl + '/ui/chat.js');
      assert.deepStrictEqual(script.status, 200);
      assert.match(script.headers.get('content-type') ?? '', /^text\/javascript/);
      const source = await script.text();
      // The page reads the stream rather than waiting for the whole body, and resends history.
      assert.match(source, /getReader\(\)/);
      assert.match(source, /prompt: text, history/);

      const model = await fetch(server.baseUrl + '/chat/model');
      assert.deepStrictEqual(await model.json(), { contextTokens: null, maxOutputTokens: 1024 });

      const spec = (await (await fetch(server.baseUrl + '/openapi.json')).json()) as {
        paths: Record<string, unknown>;
      };
      assert.deepStrictEqual(
        Object.keys(spec.paths).filter((path) => path.startsWith('/ui')),
        [],
      );
      assert.ok('/chat' in spec.paths && '/chat/model' in spec.paths);
    } finally {
      await server.stop();
    }
  });

  it('ships a script that parses as an ES module', () => {
    const script = fileURLToPath(new URL('../../public/chat.js', import.meta.url));
    // --check compiles without running, so a syntax slip fails here, not in a browser.
    execFileSync(process.execPath, ['--check', script]);
  });
});
