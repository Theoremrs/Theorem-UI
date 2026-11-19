// SOURCING: @tanstack/react-router file route; the place is validated out of the search by components/index/search
import { createFileRoute } from '@tanstack/react-router'
import { indexSearch } from '@/components/index/search'

// Index mode; the _chat layout renders the shell. The open view, item,
// collection and a record table's filter and sort live in the URL, so a view
// or a record opens directly from a link.
export const Route = createFileRoute('/_chat/index')({
  validateSearch: indexSearch,
  component: () => null,
})
