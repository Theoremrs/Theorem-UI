import { describe, expect, test } from 'bun:test'
import * as esbuild from 'esbuild-wasm'
import { tsc } from '@tsrs/wasm'
import { checkLibraryFromDisk } from '../../../test/blocks/check-library'
import { AppDependencies } from './app-dependencies'
import type { AppDependencyFetch } from './app-dependencies'
import { dependencyDeclarations } from './app-dependency-types'
import { checkAppSources } from './app-check'
import { bundleAppSources } from './export'

const HOST_BUILD = 'X-ZXJlYWN0LHJlYWN0LWRvbQ'
const pins = { '@fixture/core': '1.2.3', '@fixture/engine': '1.2.3' }
const library = checkLibraryFromDisk()

/**
 * Controlled CDN fixture with esm.sh's actual split: the app's wrapper names
 * an X-... build, while a dependent build imports a package wrapper without
 * the host external query. Published declarations use the same two roots.
 * Both copies contain identical class definitions but distinct identities.
 */
function fixtureCDN() {
  const requested: Array<string> = []
  const request: AppDependencyFetch = async (input) => {
    const url = new URL(input)
    requested.push(url.href)
    const parsed = /^\/(@fixture\/(?:core|engine))@([^/]+)(\/.*)?$/.exec(
      url.pathname,
    )
    let source: string | undefined
    let types: string | undefined
    if (url.origin === 'https://esm.sh' && parsed) {
      const name = parsed[1]!
      const version = parsed[2] === '~1.2.0' ? '1.2.3' : parsed[2]!
      const root = '/' + name + '@' + version
      const path = parsed[3] ?? ''
      const build = url.searchParams.has('external') ? HOST_BUILD + '/' : ''
      if (!path) {
        url.pathname = root
        const entry = name === '@fixture/core' ? 'core' : 'engine'
        source =
          'export * from "' + root + '/' + build + 'es2022/' + entry + '.mjs";'
        types = 'https://esm.sh' + root + '/' + build + 'dist/index.d.ts'
      } else if (/\/es2022\/core\.mjs$/.test(path)) {
        const variant = path.split('/').find((part) => part.startsWith('X-'))
        const flavor = variant && variant !== HOST_BUILD ? variant : 'default'
        source =
          'export class Device { version = ' +
          JSON.stringify(version) +
          '; flavor = ' +
          JSON.stringify(flavor) +
          '; }'
        types =
          'https://esm.sh' +
          root +
          '/' +
          (variant ? variant + '/' : '') +
          'dist/index.d.ts'
      } else if (/\/es2022\/engine\.mjs$/.test(path)) {
        source = [
          'import { Device } from "/@fixture/core@~1.2.0?target=es2022";',
          'export { Device as EngineDevice };',
          'export const acceptDevice = (device) => device.version;',
        ].join('\n')
      } else if (/\/dist\/index\.d\.ts$/.test(path)) {
        source =
          name === '@fixture/core'
            ? 'export { Device } from "./adapter/device.d.ts";'
            : [
                'import { Device } from "https://esm.sh/@fixture/core@1.2.3/dist/index.d.ts";',
                'export { Device as EngineDevice };',
                'export declare function acceptDevice(device: Device): string;',
              ].join('\n')
      } else if (/\/dist\/adapter\/device\.d\.ts$/.test(path)) {
        source =
          'export declare class Device { private identity; readonly version: "1.2.3"; }'
      }
    }
    const response = new Response(source ?? 'Fixture module not found', {
      status: source === undefined ? 404 : 200,
      headers: types ? { 'x-typescript-types': types } : {},
    })
    Object.defineProperty(response, 'url', { value: url.href })
    return response
  }
  return { resolver: new AppDependencies(pins, request), requested }
}

const directAndTransitive = {
  entry: 'main.ts',
  files: {
    'main.ts': [
      'import { Device } from "@fixture/core";',
      'import { EngineDevice, acceptDevice } from "@fixture/engine";',
      'const throughEngine: Device = new EngineDevice();',
      'export const sameClass = Device === EngineDevice;',
      'export const sameInstance = new Device() instanceof EngineDevice;',
      'export const version = acceptDevice(throughEngine);',
    ].join('\n'),
  },
}

async function execute(code: string): Promise<Record<string, unknown>> {
  return import(
    'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  )
}

describe('App dependency module identity', () => {
  test('direct and transitive CDN imports execute one shared class', async () => {
    const remote = fixtureCDN()
    const bundle = await bundleAppSources(
      directAndTransitive,
      esbuild,
      remote.resolver,
    )
    const result = await execute(bundle.code)
    expect(result.sameClass).toBe(true)
    expect(result.sameInstance).toBe(true)
    expect(result.version).toBe('1.2.3')
  }, 60_000)

  test('private class members share one direct and transitive declaration identity', async () => {
    const remote = fixtureCDN()
    const declarations = await dependencyDeclarations(
      directAndTransitive,
      remote.resolver,
    )
    expect(declarations.problems).toEqual([])
    const checked = await checkAppSources(
      directAndTransitive,
      tsc,
      library,
      {},
      declarations,
    )
    expect(checked.problems).toEqual([])
    // Nominal checking is still enforced: merging the correct identities must
    // not replace their declarations with any or erase the private member.
    const invalid = {
      ...directAndTransitive,
      files: {
        'main.ts':
          directAndTransitive.files['main.ts'] +
          '\nacceptDevice({ version: "1.2.3" });',
      },
    }
    const rejected = await checkAppSources(
      invalid,
      tsc,
      library,
      {},
      declarations,
    )
    expect(rejected.problems).toHaveLength(1)
    expect(rejected.problems[0]?.code).toBe('TS2741')
    expect(rejected.problems[0]?.message).toContain('identity')
  }, 120_000)

  test('different versions and opaque build variants retain their runtime identities', async () => {
    const remote = fixtureCDN()
    const source = {
      entry: 'main.ts',
      files: {
        'main.ts': [
          'import { Device as Old } from "@fixture/core@1.2.3";',
          'import { Device as New } from "@fixture/core@2.0.0";',
          'import { Device as FlavorA } from "https://esm.sh/@fixture/core@1.2.3/X-flavor-a/es2022/core.mjs";',
          'import { Device as FlavorB } from "https://esm.sh/@fixture/core@1.2.3/X-flavor-b/es2022/core.mjs";',
          'export const versions = [new Old().version, new New().version];',
          'export const flavors = [new FlavorA().flavor, new FlavorB().flavor];',
          'export const distinctVersions = Old !== New;',
          'export const distinctBuilds = FlavorA !== FlavorB;',
        ].join('\n'),
      },
    }
    const bundle = await bundleAppSources(source, esbuild, remote.resolver)
    const result = await execute(bundle.code)
    expect(result.versions).toEqual(['1.2.3', '2.0.0'])
    expect(result.flavors).toEqual(['X-flavor-a', 'X-flavor-b'])
    expect(result.distinctVersions).toBe(true)
    expect(result.distinctBuilds).toBe(true)
  }, 60_000)

  test('an explicit alternative build keeps its own private declaration identity', async () => {
    const remote = fixtureCDN()
    const source = {
      entry: 'main.ts',
      files: {
        'main.ts': [
          'import type { Device } from "@fixture/core";',
          'import type { Device as Alternative } from "https://esm.sh/@fixture/core@1.2.3/X-flavor-a/es2022/core.mjs";',
          'export const wrong: Device = {} as Alternative;',
        ].join('\n'),
      },
    }
    const declarations = await dependencyDeclarations(source, remote.resolver)
    expect(declarations.problems).toEqual([])
    const checked = await checkAppSources(
      source,
      tsc,
      library,
      {},
      declarations,
    )
    expect(checked.problems).toHaveLength(1)
    expect(checked.problems[0]?.code).toBe('TS2322')
    expect(checked.problems[0]?.message).toContain('identity')
  }, 120_000)

  test('an authored HTTPS build retains its runtime and private declaration identity', async () => {
    const remote = fixtureCDN()
    const source = {
      entry: 'main.ts',
      files: {
        'main.ts': [
          'import { Device } from "@fixture/core";',
          'import { Device as Explicit } from "https://esm.sh/@fixture/core@1.2.3?target=es2022";',
          'import { EngineDevice } from "@fixture/engine";',
          'import { Device as KnownHost } from "https://esm.sh/@fixture/core@1.2.3/' +
            HOST_BUILD +
            '/es2022/core.mjs";',
          'export const throughEngine: Device = new EngineDevice();',
          'export const throughKnownHost: Device = new KnownHost();',
          'export const engineSameClass = Object.is(Device, EngineDevice);',
          'export const knownHostSameClass = Object.is(Device, KnownHost);',
          'export const sameClass = Object.is(Device, Explicit);',
          'export const wrong: Device = new Explicit();',
        ].join('\n'),
      },
    }
    const bundle = await bundleAppSources(source, esbuild, remote.resolver)
    const result = await execute(bundle.code)
    expect(result.sameClass).toBe(false)
    expect(result.engineSameClass).toBe(true)
    expect(result.knownHostSameClass).toBe(true)
    // The fixture reexports Device through ./adapter/device.d.ts. The same
    // unqualified type URL is reached by the engine's managed graph and the
    // explicit HTTPS graph, whose child declaration identities must differ.
    const declarations = await dependencyDeclarations(source, remote.resolver)
    expect(declarations.problems).toEqual([])
    const checked = await checkAppSources(
      source,
      tsc,
      library,
      {},
      declarations,
    )
    expect(checked.problems).toHaveLength(1)
    expect(checked.problems[0]?.code).toBe('TS2322')
    expect(checked.problems[0]?.message).toContain('identity')
  }, 120_000)

  test('late transitive headers unify nominal declarations after an unqualified import was read', async () => {
    const root = 'https://esm.sh/@fixture/'
    const core = root + 'core@1.2.3/'
    const fixture: AppDependencyFetch = async (input) => {
      const url = new URL(input)
      let source: string | undefined
      let types: string | undefined
      if (/\/@fixture\/(?:alpha|beta)@1\.2\.3$/.test(url.pathname)) {
        const name = url.pathname.includes('/alpha@') ? 'alpha' : 'beta'
        source = 'export {};'
        types = root + name + '@1.2.3/' + HOST_BUILD + '/dist/index.d.ts'
      } else if (url.pathname === '/@fixture/core@1.2.3') {
        // The absolute declaration can be discovered before this transitive
        // package's canonical build header, even after all root headers arrive.
        await new Promise((resolve) => setTimeout(resolve, 30))
        source = 'export {};'
        types = core + HOST_BUILD + '/dist/index.d.ts'
      } else if (
        /\/alpha@1\.2\.3\/X-[^/]+\/dist\/index\.d\.ts$/.test(url.pathname)
      ) {
        source = [
          'import { Device } from "' + core + 'dist/index.d.ts";',
          'export declare function makeDevice(): Device;',
        ].join('\n')
      } else if (
        /\/beta@1\.2\.3\/X-[^/]+\/dist\/index\.d\.ts$/.test(url.pathname)
      ) {
        source = [
          'import { Device } from "@fixture/core@1.2.3";',
          'export declare function acceptDevice(device: Device): void;',
        ].join('\n')
      } else if (
        /\/core@1\.2\.3\/(?:X-[^/]+\/)?dist\/index\.d\.ts$/.test(url.pathname)
      ) {
        source = 'export { Device } from "./adapter/device.d.ts";'
      } else if (
        /\/core@1\.2\.3\/(?:X-[^/]+\/)?dist\/adapter\/device\.d\.ts$/.test(
          url.pathname,
        )
      ) {
        source = 'export declare class Device { private identity; }'
      }
      return new Response(source ?? 'Fixture declaration not found', {
        status: source === undefined ? 404 : 200,
        headers: types ? { 'x-typescript-types': types } : {},
      })
    }
    const source = {
      entry: 'main.ts',
      files: {
        'main.ts': [
          'import { makeDevice } from "@fixture/alpha@1.2.3";',
          'import { acceptDevice } from "@fixture/beta@1.2.3";',
          'acceptDevice(makeDevice());',
        ].join('\n'),
      },
    }
    const declarations = await dependencyDeclarations(
      source,
      new AppDependencies({}, fixture),
    )
    expect(declarations.problems).toEqual([])
    const checked = await checkAppSources(
      source,
      tsc,
      library,
      {},
      declarations,
    )
    expect(checked.problems).toEqual([])
  }, 120_000)

  test('explicit HTTPS React and renderer pins keep their own dependency graph', async () => {
    const request: AppDependencyFetch = async (input) => {
      const url = new URL(input)
      let source: string | undefined
      const externalReact = url.searchParams
        .get('external')
        ?.split(',')
        .includes('react')
      if (url.pathname === '/react@18.3.1') {
        source = 'export * from "/react@18.3.1/es2022/react.mjs";'
      } else if (url.pathname === '/react-dom@18.3.1/client') {
        source =
          'export * from "/react-dom@18.3.1/' +
          (externalReact ? HOST_BUILD + '/' : '') +
          'es2022/client.mjs";'
      } else if (url.pathname === '/react-dom@18.3.1') {
        source =
          'export * from "/react-dom@18.3.1/' +
          (externalReact ? HOST_BUILD + '/' : '') +
          'es2022/react-dom.mjs";'
      } else if (url.pathname === '/react@18.3.1/es2022/react.mjs') {
        source = 'export const version = "18.3.1";'
      } else if (
        /^\/react-dom@18\.3\.1\/(?:X-[^/]+\/)?es2022\/client\.mjs$/.test(
          url.pathname,
        )
      ) {
        // An authored HTTPS graph also owns its nested package wrappers.
        source =
          'export { rendererReactVersion } from "/react-dom@18.3.1?target=es2022";'
      } else if (
        /^\/react-dom@18\.3\.1\/(?:X-[^/]+\/)?es2022\/react-dom\.mjs$/.test(
          url.pathname,
        )
      ) {
        const imported = url.pathname.includes('/X-')
          ? 'react'
          : '/react@18.3.1/es2022/react.mjs'
        source =
          'import { version } from "' +
          imported +
          '"; export const rendererReactVersion = version;'
      }
      return new Response(source ?? 'Fixture module not found', {
        status: source === undefined ? 404 : 200,
      })
    }
    const source = {
      entry: 'main.ts',
      files: {
        'main.ts': [
          'import { version } from "https://esm.sh/react@18.3.1?target=es2022";',
          'import { rendererReactVersion } from "https://esm.sh/react-dom@18.3.1/client?target=es2022";',
          'export const versions = [version, rendererReactVersion];',
        ].join('\n'),
      },
    }
    const bundle = await bundleAppSources(
      source,
      esbuild,
      new AppDependencies({}, request),
    )
    const result = await execute(bundle.code)
    expect(result.versions).toEqual(['18.3.1', '18.3.1'])
  }, 60_000)

  test('normalization preserves dependency overrides, aliases, conditions and other origins', () => {
    const resolver = new AppDependencies()
    const importer = resolver.resolve('@fixture/engine@1.2.3').path
    const url = new URL(
      resolver.resolve(
        'https://esm.sh/@fixture/core@1.2.3?target=es2020&dev&conditions=worker&alias=react:preact/compat&deps=other@2.0.0&external=custom',
        importer,
      ).path,
    )
    expect(url.searchParams.get('target')).toBe('es2020')
    expect(url.searchParams.has('dev')).toBe(true)
    expect(url.searchParams.get('conditions')).toBe('worker')
    expect(url.searchParams.get('alias')).toBe('react:preact/compat')
    expect(url.searchParams.get('deps')).toBe('other@2.0.0')
    expect(url.searchParams.get('external')?.split(',')).toContain('custom')
    const other =
      'https://modules.example/core@1.2.3?target=es2020&external=custom'
    expect(resolver.resolve(other, importer).path).toBe(other)
    const compiled =
      'https://esm.sh/@fixture/core@1.2.3/X-flavor-a/es2020/core.mjs'
    expect(resolver.resolve(compiled, importer).path).toBe(compiled)
    const asset = 'https://esm.sh/@fixture/core@1.2.3/data.wasm'
    expect(resolver.resolve(asset, importer).path).toBe(asset)
    expect(
      resolver.resolve('https://esm.sh/@fixture/core@1.2.3/extra', importer)
        .path,
    ).toContain('/@fixture/core@1.2.3/extra')
  })
})
