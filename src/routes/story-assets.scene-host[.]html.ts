// SOURCING: none — TanStack Start server route serving the committed SceneOS frame page to the review stories, with the policy the authority serves it with (theorem_scene_host.rs). Development only, like the component stories.
import { createFileRoute } from '@tanstack/react-router'
import { SCENE_HOST_POLICY } from '@/stories/fixtures/scenes'

export const Route = createFileRoute('/story-assets/scene-host.html')({
  server: {
    handlers: {
      GET: async () => {
        if (!import.meta.env.DEV) return new Response(null, { status: 404 })
        const { default: page } = await import(
          '@/stories/fixtures/scene/host.html?raw'
        )
        return new Response(page, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': SCENE_HOST_POLICY,
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            'cache-control': 'no-cache',
          },
        })
      },
    },
  },
})
