import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Module } from '../../src/decorators/module.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

describe('Module', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('records controllers, providers, and imports on its class', () => {
    class Controller {}
    class Provider {}
    class Imported {}

    @Module({ controllers: [Controller], providers: [Provider], imports: [Imported] })
    class Feature {}

    expect(metadataStore.getModule(Feature)).toEqual({
      controllers: [Controller],
      providers: [Provider],
      imports: [Imported],
    });
  });

  it('records empty lists when every member is omitted', () => {
    @Module({})
    class Empty {}

    expect(metadataStore.getModule(Empty)).toEqual({
      controllers: [],
      providers: [],
      imports: [],
    });
  });
});
