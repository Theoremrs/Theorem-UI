// SOURCING: @tanstack/react-router file route; the table's view (previewed record, filter, sort) is validated out of the search by components/crm/navigation
import { createFileRoute } from '@tanstack/react-router'
import { crmTableSearch } from '@/components/crm/navigation'

// One type's records, by the type's plural name; ModeView shows its table.
export const Route = createFileRoute('/_chat/crm/$objectType')({
  validateSearch: crmTableSearch,
  component: () => null,
})
