import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { REST_SHOWCASE_FILES } from '../../../src/templates/rest-showcase.ts';

describe('the functional REST showcase', () => {
  it('is a function controller and a plain service in the flat homes', () => {
    expect(REST_SHOWCASE_FILES.map((file) => file.path)).toEqual([
      'src/services/greeting.service.ts',
      'src/controllers/greeting.controller.ts',
    ]);
    const [service, controller] = REST_SHOWCASE_FILES;
    // The functional services barrel admits a file by this export.
    expect(service!.contents).toContain(
      "export function describeGreeting(name = 'world'): string {",
    );
    expect(controller!.contents).toContain(
      "import { describeGreeting } from '../services/greeting.service.ts';",
    );
    expect(controller!.contents).toContain('export function registerGreetingRoutes(');
    expect(controller!.contents).toContain("router.group('/greetings'");
    for (const file of REST_SHOWCASE_FILES)
      expect(
        ts.transpileModule(file.contents, {
          compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
          reportDiagnostics: true,
        }).diagnostics,
        file.path,
      ).toEqual([]);
  });
});
