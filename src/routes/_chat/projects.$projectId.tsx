import { createFileRoute } from '@tanstack/react-router'

type ProjectSearch = {
  /** Just made from the sidebar: the page opens with its name ready to type over. */
  naming?: true
}

// A project's page; the _chat layout keeps the shell and the sidebar, and the
// chat mode's view shows the project in place of a conversation.
export const Route = createFileRoute('/_chat/projects/$projectId')({
  validateSearch: (search: Record<string, unknown>): ProjectSearch =>
    search.naming === true || search.naming === 'true' ? { naming: true } : {},
  component: () => null,
})
