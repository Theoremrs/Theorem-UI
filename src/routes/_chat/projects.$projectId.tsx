import { createFileRoute } from '@tanstack/react-router'

// A project's page; the _chat layout keeps the shell and the sidebar, and the
// chat mode's view shows the project in place of a conversation.
export const Route = createFileRoute('/_chat/projects/$projectId')({
  component: () => null,
})
