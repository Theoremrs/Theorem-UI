import { expect, test } from 'bun:test'
import type { ThreadMessage } from '@assistant-ui/react'
import { SCENE_CONTRACT, SCENE_PART } from '@/components/chat/scene-model'
import {
  ARTIFACT_PART,
  kindLabel,
  readArtifact,
  readSceneArtifact,
  threadArtifacts,
} from './artifact-model'
import {
  fileNameOf,
  isBare,
  isLive,
  representationOf,
  sourceOf,
} from './artifact-registry'
import './artifact-renderers'

const PACKAGE = { id: 'two-bit-adder', atoms: [] }

function scenePayload(packageHash: string) {
  return {
    contractVersion: SCENE_CONTRACT,
    sceneId: 'two-bit-adder',
    title: 'How does a two-bit adder add?',
    fallbackText: 'A two-bit adder reads both operands and adds them.',
    packageHash,
    scenePackage: PACKAGE,
  }
}

function reply(
  id: string,
  parts: ReadonlyArray<{ name: string; data: unknown }>,
): ThreadMessage {
  return {
    id,
    role: 'assistant',
    createdAt: new Date(0),
    status: { type: 'complete', reason: 'stop' },
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {},
    },
    content: parts.map((part) => ({ type: 'data', ...part })),
  } as unknown as ThreadMessage
}

test('a saved scene part reads as a scene artifact: one identity, its package hash as the revision', () => {
  const scene = readSceneArtifact(scenePayload('h1'))!
  expect(scene.artifactId).toBe('scene:two-bit-adder')
  expect(scene.revision).toBe('h1')
  expect(scene.kind).toBe('scene')
  expect(scene.scene?.scenePackage).toEqual(PACKAGE)
  expect(kindLabel(scene)).toBe('Scene')
  expect(
    readSceneArtifact({ contractVersion: 'other', sceneId: 'x' }),
  ).toBeUndefined()
})

test('a scene is bare in the reply, fills a panel in the workspace, and never waits behind Interact', () => {
  const scene = readSceneArtifact(scenePayload('h1'))!
  expect(representationOf(scene, 'preview').renderer).toBe(
    'theorem-scene.reply',
  )
  expect(isBare(scene, 'preview')).toBe(true)
  expect(representationOf(scene, 'interactive').renderer).toBe('theorem-scene')
  expect(isBare(scene, 'interactive')).toBe(false)
  expect(isLive(scene, 'interactive')).toBe(false)
})

test("a scene's source is its package as JSON", async () => {
  const scene = readSceneArtifact(scenePayload('h1'))!
  const source = sourceOf(scene, true)
  expect(source.mediaType).toBe('application/json')
  expect(JSON.parse(await source.load())).toEqual(PACKAGE)
  expect(fileNameOf(scene, true)).toBe('how-does-a-two-bit-adder-add.json')
})

test('a scene artifact envelope carries the scene part payload', () => {
  const envelope = readArtifact({
    artifactId: 'artifact-7',
    artifactRevision: 'r1',
    artifactKind: 'scene',
    rendererId: 'theorem-scene',
    payload: scenePayload('h1'),
  })!
  expect(envelope.scene?.sceneId).toBe('two-bit-adder')
  expect(isBare(envelope, 'preview')).toBe(true)
})

test('replayed scene parts list once per revision, and a scene the envelope carries is not listed again', () => {
  const listed = threadArtifacts([
    reply('m1', [{ name: SCENE_PART, data: scenePayload('h1') }]),
    // The same part replayed, then a revised package.
    reply('m1-replay', [{ name: SCENE_PART, data: scenePayload('h1') }]),
    reply('m2', [{ name: SCENE_PART, data: scenePayload('h2') }]),
  ])
  expect([...listed.keys()]).toEqual(['scene:two-bit-adder'])
  expect(listed.get('scene:two-bit-adder')?.map((a) => a.revision)).toEqual([
    'h1',
    'h2',
  ])

  const carried = threadArtifacts([
    reply('m3', [
      {
        name: ARTIFACT_PART,
        data: {
          artifactId: 'artifact-7',
          artifactRevision: 'r1',
          artifactKind: 'scene',
          payload: scenePayload('h3'),
        },
      },
      { name: SCENE_PART, data: scenePayload('h3') },
    ]),
  ])
  expect([...carried.keys()]).toEqual(['artifact-7'])
})
