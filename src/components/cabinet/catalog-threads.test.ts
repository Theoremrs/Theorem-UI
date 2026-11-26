// SOURCING: none — bun:test over ./catalog's storedArtifacts, the reader a kept panel's origin conversation goes through, given stored messages in the SDK's own shape
import { expect, test } from 'bun:test'
import type { Theorem } from '@/lib/theorem/client'
import { SCENE_CONTRACT } from '@/components/chat/scene-model'
import { storedArtifacts } from './catalog'

const scene = {
  contractVersion: SCENE_CONTRACT,
  sceneId: 'cpu',
  title: 'How does a CPU work?',
  fallbackText: 'A simplified RISC-V processor.',
  packageHash: 'a'.repeat(64),
  scenePackage: { id: 'cpu', atoms: [] },
}

const messages = [
  {
    messageId: 'q1',
    threadId: 'thread_origin',
    role: 'user',
    createdAtMs: 1,
    parts: [{ partId: 'p0', type: 'text', payload: { text: 'How?' } }],
  },
  {
    messageId: 'reply-1',
    threadId: 'thread_origin',
    role: 'assistant',
    createdAtMs: 2,
    parts: [{ partId: 'p1', type: 'scene', payload: scene }],
  },
] as unknown as Theorem.Message[]

test('a saved scene part in a stored conversation reads as its scene artifact, as on screen', () => {
  const versions = storedArtifacts(messages).get('scene:cpu')
  expect(versions?.map((v) => v.revision)).toEqual(['a'.repeat(64)])
  expect(versions?.[0]?.kind).toBe('scene')
})
