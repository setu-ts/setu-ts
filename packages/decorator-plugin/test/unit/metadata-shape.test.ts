import { beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Controller, Version } from '../../src/decorators/controller.ts';
import { Delete, Get, Post } from '../../src/decorators/http.ts';
import {
  Body,
  Cookie,
  Ctx,
  CurrentUser,
  Custom,
  Header,
  Param,
  Params,
  Query,
} from '../../src/decorators/params.ts';
import { Inject, Injectable, Optional } from '../../src/decorators/injection.ts';
import { Permissions, Public, Roles } from '../../src/decorators/security.ts';
import { UseGuards } from '../../src/decorators/pipeline.ts';
import { ValidateBody } from '../../src/decorators/validation.ts';
import { ApiOperation, ApiResponse, ApiTags } from '../../src/decorators/openapi.ts';
import { createDecorator } from '../../src/decorators/custom.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';
import type { Constructor } from '@setu-ts/common';

/**
 * Guards the standard-decorator rewrite against the LEGACY implementation's
 * recorded output.
 *
 * The fixture was captured by running the pre-migration decorators over the
 * controller below and serializing the store (M76 §3.5). A test written only
 * against the new code cannot distinguish "correct" from "consistently wrong";
 * this fixture can, because nothing in this milestone produced it.
 *
 * Two documented divergences, both established by reading the consumers rather
 * than assumed:
 *
 * - `params` are compared as an index-keyed SET. Legacy stored them descending
 *   (parameter decorators evaluate in reverse); the positional form stores them
 *   ascending. `resolveParameters` places arguments by `param.index` and never
 *   by array position, and `openapi-plugin` reads the Zod `schema.params`, not
 *   this array, so the order is not load-bearing.
 * - `Ctx()`'s marker is a SYMBOL key and does not survive `JSON.stringify`, so
 *   it reads as `{}` in the fixture. It is asserted by identity in
 *   `params.test.ts` and across package copies in `context-marker-copies.test.ts`.
 */
const baseline = JSON.parse(
  await Deno.readTextFile(new URL('../fixtures/legacy-metadata-baseline.json', import.meta.url)),
) as Record<string, [string, unknown][]>;

/** Replays the serialization the capture script used, so the two are comparable. */
function serialize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'function' ? `[fn ${v.name || 'anon'}]` : v)),
  );
}

function entry(section: string, name: string): unknown {
  const row = baseline[section]?.find(([n]) => n === name);
  if (row === undefined) {
    throw new Error(`baseline has no ${section} entry for ${name}`);
  }
  return row[1];
}

const guard = (): void => {};
const Tenant = () => Custom('tenant', { scope: 'request' });
const Cacheable = (ttl: number) => createDecorator('cache:cacheable', { ttl });

@Injectable({ scope: 'singleton', token: 'widget-service' })
@Inject('database', 'logger')
class WidgetService {}

@Injectable()
@Inject('database', Optional('cache'))
class OtherService {}

@Controller('/widgets')
@Version('v1')
@ApiTags('widgets')
@Roles('admin')
class WidgetController {
  @Get('/')
  @ApiOperation({ summary: 'list', operationId: 'listWidgets' })
  @Cacheable(60)
  @Params(Query('page'), Query(), Ctx())
  list(_p: string, _all: Readonly<Record<string, string>>, _c: unknown): void {}

  @Get('/:id')
  @Public()
  @Params(Param('id'), Header('x-trace'), Cookie('sid'))
  show(_id: string, _t: string | undefined, _s: string | undefined): void {}

  @Post('/')
  @ValidateBody({ kind: 'schema' })
  @UseGuards(guard)
  @Permissions('widgets:write')
  @ApiResponse({ status: 201, description: 'created' })
  @Params(Body(), CurrentUser(), Tenant())
  create(_b: unknown, _u: unknown, _t: unknown): void {}

  @Delete('/:id')
  @Get('/legacy-alias')
  @Params(Param('id'))
  remove(_id: string): void {}
}

describe('metadata shape vs the legacy baseline', () => {
  let routes: ReturnType<typeof metadataStore.getRoutesFor>;

  beforeAll(() => {
    routes = metadataStore.getRoutesFor(WidgetController as unknown as Constructor);
  });

  it('records the controller exactly as the legacy implementation did', () => {
    expect(serialize(metadataStore.getController(WidgetController as unknown as Constructor)))
      .toEqual(entry('controllers', 'WidgetController'));
  });

  it('records a class-position @Inject service exactly as the legacy implementation did', () => {
    // WidgetService already used the class-position list, which this milestone
    // keeps, so its record must be byte-identical.
    expect(serialize(metadataStore.getService(WidgetService as unknown as Constructor)))
      .toEqual(entry('services', 'WidgetService'));
  });

  it('migrates a parameter-position @Inject list intact into the service record', () => {
    // The one deliberate divergence. Legacy stored the parameter-position list
    // under `ctorInject` and left `services` empty; the collapsed form stores
    // the SAME tokens, in the same order, under `services.inject`. Asserting
    // equality with the legacy `services` entry would assert the storage
    // location rather than the tokens — this asserts the tokens survived.
    const record = metadataStore.getService(OtherService as unknown as Constructor);
    expect(record?.inject).toEqual(entry('ctorInject', 'OtherService'));
    expect(entry('services', 'OtherService')).toEqual({});
  });

  it('records the same optional constructor arguments', () => {
    expect([...metadataStore.ctorOptional(OtherService as unknown as Constructor)])
      .toEqual(entry('ctorOptional', 'OtherService'));
    expect([...metadataStore.ctorOptional(WidgetService as unknown as Constructor)])
      .toEqual(entry('ctorOptional', 'WidgetService'));
  });

  it('records the same routes, in the same order, with the same non-parameter fields', () => {
    const legacy = entry('routes', 'WidgetController') as Record<string, unknown>[];
    const actual = serialize(routes) as Record<string, unknown>[];
    expect(actual).toHaveLength(legacy.length);
    for (let i = 0; i < legacy.length; i++) {
      const { params: _lp, ...legacyRest } = legacy[i];
      const { params: _ap, ...actualRest } = actual[i];
      expect(actualRest).toEqual(legacyRest);
    }
  });

  it('records the same parameters, compared as an index-keyed set', () => {
    const legacy = entry('routes', 'WidgetController') as { params: { index: number }[] }[];
    const actual = serialize(routes) as { params: { index: number }[] }[];
    const byIndex = (ps: { index: number }[]) => [...ps].sort((a, b) => a.index - b.index);
    for (let i = 0; i < legacy.length; i++) {
      expect(byIndex(actual[i].params)).toEqual(byIndex(legacy[i].params));
    }
  });

  it('records the same custom decorators', () => {
    expect(serialize(metadataStore.getCustomDecorators())).toEqual(baseline['custom']);
  });
});
