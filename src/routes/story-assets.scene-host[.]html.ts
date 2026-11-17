// SOURCING: none — TanStack Start server route serving the committed SceneOS frame page to the review stories, with the policy the authority serves it with (theorem_scene_host.rs). Development only, like the component stories.
import { createFileRoute } from '@tanstack/react-router'
import { SCENE_HOST_POLICY, SCENE_STUDY_PAGE_CSS } from '@/stories/fixtures/scenes'
import type { SceneStudy } from '@/stories/fixtures/scenes'

export const Route = createFileRoute('/story-assets/scene-host.html')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!import.meta.env.DEV) return new Response(null, { status: 404 })
        const { default: page } = await import(
          '@/stories/fixtures/scene/host.html?raw'
        )
        // A presentation study (fixtures/scenes.ts) adds its CSS after the page's own.
        const study = new URL(request.url).searchParams.get('study')
        const css =
          study && Object.hasOwn(SCENE_STUDY_PAGE_CSS, study)
            ? SCENE_STUDY_PAGE_CSS[study as SceneStudy]
            : undefined
        const html = css ? page.replace('</head>', `<style>${css}</style>\n</head>`) : page
        return new Response(html, {
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
