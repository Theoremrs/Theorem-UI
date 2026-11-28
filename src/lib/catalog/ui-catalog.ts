// SOURCING: package.json (the declared version of each library, so the
// catalog cannot drift from what is installed) and the canonical entry points
// feature code already imports (src/components/coss, src/components/ui,
// src/components/data-table, src/components/assistant-ui). Machine-readable
// form of the UI-02 one-component-per-purpose policy for the authoring SDK.
import { dependencies, devDependencies } from '../../../package.json'

export type UiCatalogLibrary = {
  /** npm package that supplies the behavior. */
  name: string
  /** The range package.json declares for it. */
  version: string
}

export type UiCatalogEntry = {
  purpose: string
  /** The `@/` alias path feature code imports from; null when no canonical
   *  wrapper exists and code imports the library directly. */
  importPath: string | null
  exports: string[]
  library: UiCatalogLibrary
  /** True when `importPath` is the one supported entry for the purpose. */
  canonical: boolean
  /** A TSX snippet showing the supported import and use. */
  example: string
  /** Theme tokens and capabilities the entry depends on, plus caveats. */
  notes: string
}

const deps: Record<string, string> = {
  ...dependencies,
  ...devDependencies,
}

const lib = (name: string): UiCatalogLibrary => {
  const version = deps[name]
  if (version === undefined) {
    throw new Error(`ui-catalog: ${name} is not declared in package.json`)
  }
  return { name, version }
}

export const UI_CATALOG: UiCatalogEntry[] = [
  {
    purpose: 'button',
    importPath: '@/components/ui/button',
    exports: ['Button', 'buttonVariants'],
    library: lib('@base-ui/react'),
    canonical: true,
    example: `import { Button } from '@/components/ui/button'

export const Save = () => <Button variant="default">Save</Button>`,
    notes:
      'shadcn/ui base-nova (components.json). Uses --color-primary and --radius. coss has no button.',
  },
  {
    purpose: 'dialog',
    importPath: '@/components/ui/dialog',
    exports: [
      'Dialog',
      'DialogClose',
      'DialogContent',
      'DialogDescription',
      'DialogFooter',
      'DialogHeader',
      'DialogTitle',
      'DialogTrigger',
    ],
    library: lib('@base-ui/react'),
    canonical: true,
    example: `import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

export const Ask = () => (
  <Dialog>
    <DialogTrigger>Open</DialogTrigger>
    <DialogContent>
      <DialogTitle>Title</DialogTitle>
    </DialogContent>
  </Dialog>
)`,
    notes:
      'For destructive confirmation use the alert-dialog entry instead. Competing: @/components/coss/alert-dialog covers only confirmations.',
  },
  {
    purpose: 'alert-dialog',
    importPath: '@/components/coss/alert-dialog',
    exports: ['AlertDialog', 'AlertDialogPopup', 'AlertDialogTrigger'],
    library: lib('@base-ui/react'),
    canonical: true,
    example: `import { AlertDialog, AlertDialogPopup, AlertDialogTrigger } from '@/components/coss/alert-dialog'`,
    notes: 'COSS UI on Base UI. Confirmations that need an explicit answer.',
  },
  {
    purpose: 'menu',
    importPath: '@/components/coss/menu',
    exports: [
      'Menu',
      'MenuTrigger',
      'MenuPopup',
      'MenuItem',
      'MenuSeparator',
      'MenuSub',
      'MenuSubTrigger',
      'MenuSubPopup',
    ],
    library: lib('@base-ui/react'),
    canonical: true,
    example: `import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/coss/menu'

export const Actions = () => (
  <Menu>
    <MenuTrigger>Actions</MenuTrigger>
    <MenuPopup>
      <MenuItem>Rename</MenuItem>
    </MenuPopup>
  </Menu>
)`,
    notes:
      'Uses --color-popover. src/components/glass/menu-glass.tsx is a styled variant, not a second menu.',
  },
  {
    purpose: 'popover',
    importPath: '@/components/coss/popover',
    exports: ['Popover', 'PopoverTrigger', 'PopoverPopup', 'PopoverClose'],
    library: lib('@base-ui/react'),
    canonical: true,
    example: `import { Popover, PopoverPopup, PopoverTrigger } from '@/components/coss/popover'`,
    notes:
      'Competing copy inside data-table (@/components/data-table/ui/popover) exists for the table toolbar only.',
  },
  {
    purpose: 'tooltip',
    importPath: '@/components/coss/tooltip',
    exports: ['Tooltip', 'TooltipProvider', 'TooltipTrigger', 'TooltipPopup'],
    library: lib('@base-ui/react'),
    canonical: true,
    example: `import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/coss/tooltip'`,
    notes:
      'Duplicate: @/components/ui/tooltip also exists (Tooltip, TooltipContent). Prefer coss. Icon buttons with a tooltip: @/components/assistant-ui/elements/tooltip-icon-button.',
  },
  {
    purpose: 'tabs',
    importPath: '@/components/coss/tabs',
    exports: ['Tabs', 'TabsList', 'TabsTab', 'TabsPanel'],
    library: lib('@base-ui/react'),
    canonical: true,
    example: `import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/coss/tabs'`,
    notes:
      'Two-to-five peer views inside one surface. Docking uses Dockview instead.',
  },
  {
    purpose: 'select',
    importPath: '@/components/coss/select',
    exports: [
      'Select',
      'SelectTrigger',
      'SelectValue',
      'SelectPopup',
      'SelectItem',
    ],
    library: lib('@base-ui/react'),
    canonical: true,
    example: `import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/coss/select'`,
    notes:
      'Duplicate: @/components/data-table/ui/select (table toolbar only). Searchable choice: @/components/coss/combobox or autocomplete.',
  },
  {
    purpose: 'input',
    importPath: '@/components/coss/input',
    exports: ['Input'],
    library: lib('@base-ui/react'),
    canonical: true,
    example: `import { Input } from '@/components/coss/input'

export const Name = () => <Input placeholder="Name" />`,
    notes:
      'Duplicate: @/components/ui/input (20 importers) vs coss/input (32). coss is canonical; ui/input remains in older code. Same split for textarea, badge and alert.',
  },
  {
    purpose: 'textarea',
    importPath: '@/components/coss/textarea',
    exports: ['Textarea'],
    library: lib('@base-ui/react'),
    canonical: true,
    example: `import { Textarea } from '@/components/coss/textarea'`,
    notes: 'Duplicate: @/components/ui/textarea.',
  },
  {
    purpose: 'badge',
    importPath: '@/components/coss/badge',
    exports: ['Badge', 'badgeVariants'],
    library: lib('@base-ui/react'),
    canonical: true,
    example: `import { Badge } from '@/components/coss/badge'`,
    notes: 'Duplicate: @/components/ui/badge. CRM record tags: crm/twenty/tag.',
  },
  {
    purpose: 'notification',
    importPath: '@/components/coss/toast',
    exports: ['toastManager', 'ToastProvider'],
    library: lib('@base-ui/react'),
    canonical: true,
    example: `import { toastManager } from '@/components/coss/toast'

toastManager.add({ title: 'Saved' })`,
    notes: 'Alerts inline in a page use @/components/coss/alert.',
  },
  {
    purpose: 'data-table',
    importPath: '@/components/data-table/table-hook',
    exports: [
      'useAppTable',
      'createAppColumnHelper',
      'useTableContext',
      'useCellContext',
      'useHeaderContext',
    ],
    library: lib('@tanstack/react-table'),
    canonical: true,
    example: `import { createAppColumnHelper, useAppTable } from '@/components/data-table/table-hook'

type Row = { id: string; name: string }
const column = createAppColumnHelper<Row>()
const columns = [column.accessor('name', { header: 'Name' })]

export const useRows = (data: Row[]) => useAppTable({ columns, data })`,
    notes:
      'TanStack Table v9 createTableHook with Theorem features (sort, filter, resize, pagination). Plain src/components/ui/table is markup only, not a data table.',
  },
  {
    purpose: 'virtual-list',
    importPath: null,
    exports: ['useVirtualizer'],
    library: lib('@tanstack/react-virtual'),
    canonical: false,
    example: `import { useVirtualizer } from '@tanstack/react-virtual'`,
    notes:
      'No shared adapter exists; csv-handler, pdf-handler and work-list each call useVirtualizer directly. A wrapper is a gap to fill.',
  },
  {
    purpose: 'conversation',
    importPath: '@/components/assistant-ui/elements/thread.aui',
    exports: ['Thread', 'Composer', 'AssistantMessageContent'],
    library: lib('@assistant-ui/react'),
    canonical: true,
    example: `import { Thread } from '@/components/assistant-ui/elements/thread.aui'`,
    notes:
      'Thread list: elements/thread-list.aui. Surfaces: elements/surfaces. Installed through the @assistant-ui registry in components.json.',
  },
  {
    purpose: 'docking',
    importPath: '@/components/shell/dock',
    exports: ['DockShell'],
    library: lib('dockview-react'),
    canonical: false,
    example: `import { DockviewReact } from 'dockview-react'`,
    notes:
      'DockShell is the app shell only. Notes (notes-workspace) and workspace file panels import dockview-react directly; no reusable dock adapter. Dockview tokens are --dv-*.',
  },
  {
    purpose: 'page',
    importPath: '@/components/pages/page-view',
    exports: ['PageView', 'VaultPage', 'ModePageView'],
    library: lib('@puckeditor/core'),
    canonical: true,
    example: `import { PageView } from '@/components/pages/page-view'

export const Open = ({ id }: { id: string }) => <PageView entryId={id} />`,
    notes:
      'Puck pages; modules and their registry live in src/lib/modules (registry.ts, contract.ts).',
  },
  {
    purpose: 'rich-text',
    importPath: '@/components/notes/note-editor',
    exports: ['NoteEditor', 'MarkdownBlocks'],
    library: lib('@milkdown/react'),
    canonical: true,
    example: `import { NoteEditor } from '@/components/notes/note-editor'`,
    notes:
      'Milkdown Crepe. Also @/components/handlers/markdown/editor (MarkdownEditor) for vault markdown files: two editors share Milkdown. Tokens: --crepe-*.',
  },
  {
    purpose: 'code',
    importPath: '@/components/blocks/source-editor',
    exports: ['SourceEditor'],
    library: lib('@uiw/react-codemirror'),
    canonical: true,
    example: `import { SourceEditor } from '@/components/blocks/source-editor'`,
    notes:
      'CodeMirror 6. Theme hook: useCodeMirrorTheme in @/lib/codemirror-theme. program/ and handlers/code import react-codemirror directly. Read-only display: assistant-ui/elements/code-file.',
  },
  {
    purpose: 'calendar',
    importPath: '@/components/blocks/query-calendar',
    exports: ['default'],
    library: lib('@fullcalendar/react'),
    canonical: true,
    example: `import QueryCalendar from '@/components/blocks/query-calendar'`,
    notes: 'FullCalendar day grid over a query view result.',
  },
  {
    purpose: 'tree',
    importPath: '@/components/ui/filesystem-tree',
    exports: ['FilesystemTree'],
    library: lib('@headless-tree/react'),
    canonical: false,
    example: `import { useTree } from '@headless-tree/react'`,
    notes:
      'FilesystemTree is a presentational file tree. workspace-tree and ide-file-tree each call headless-tree directly.',
  },
  {
    purpose: 'drag-and-drop',
    importPath: '@/components/data-table/ui/sortable',
    exports: ['Sortable'],
    library: lib('@dnd-kit/core'),
    canonical: false,
    example: `import { DndContext } from '@dnd-kit/core'`,
    notes:
      'Sortable wraps dnd-kit for table columns/lists only; crm/header-drag, notes/note-drop and shell/rail use dnd-kit directly.',
  },
  {
    purpose: 'record-presentation',
    importPath: '@/components/crm/twenty/chip',
    exports: ['Chip'],
    library: lib('react'),
    canonical: true,
    example: `import { Chip } from '@/components/crm/twenty/chip'
import { Avatar } from '@/components/crm/twenty/avatar'
import { Tag } from '@/components/crm/twenty/tag'`,
    notes:
      'Twenty-derived CRM atoms (Avatar, Chip, Tag, Checkbox in the same folder). Record pages: @/components/crm/record-fields.',
  },
  {
    purpose: 'remote-state',
    importPath: null,
    exports: ['useQuery', 'useMutation', 'useQueryClient'],
    library: lib('@tanstack/react-query'),
    canonical: true,
    example: `import { useQuery } from '@tanstack/react-query'`,
    notes:
      'Imported directly everywhere (no wrapper); that is the supported entry. Domain hooks live in each area queries.ts (crm/queries, records/queries).',
  },
]

export type ThemeTokenGroup =
  'color' | 'typography' | 'spacing' | 'radius' | 'motion'

export type ThemeToken = { name: string; group: ThemeTokenGroup }

/** CSS custom properties defined in src/styles.css that SDK code may rely on. */
export const THEME_TOKENS: ThemeToken[] = [
  ...[
    'background',
    'foreground',
    'primary',
    'primary-foreground',
    'secondary',
    'muted',
    'muted-foreground',
    'accent',
    'card',
    'popover',
    'border',
    'input',
    'ring',
    'destructive',
    'success',
    'warning',
    'info',
    'action',
    'ink',
    'ink-muted',
  ].map((n): ThemeToken => ({ name: `--color-${n}`, group: 'color' })),
  ...[
    '--font-sans',
    '--font-heading',
    '--font-mono',
    '--text-sm',
    '--text-base',
    '--text-md',
  ].map((name): ThemeToken => ({ name, group: 'typography' })),
  ...[
    '--spacing-rail',
    '--spacing-inspector',
    '--spacing-reading',
    '--spacing-artifact',
  ].map((name): ThemeToken => ({ name, group: 'spacing' })),
  ...[
    '--radius',
    '--radius-sm',
    '--radius-md',
    '--radius-lg',
    '--radius-xl',
  ].map((name): ThemeToken => ({ name, group: 'radius' })),
  ...[
    '--ease-snap',
    '--ease-settle',
    '--ease-glide',
    '--ease-exit',
    '--duration-snap',
    '--duration-settle',
    '--duration-glide',
    '--duration-exit',
    '--beat',
  ].map((name): ThemeToken => ({ name, group: 'motion' })),
]

export type UiCatalogDescription = {
  schema: 'theorem.ui-catalog/1'
  components: UiCatalogEntry[]
  tokens: ThemeToken[]
}

/** The catalog as plain JSON-serializable data for the authoring SDK. */
export function describeUiCatalog(): UiCatalogDescription {
  return {
    schema: 'theorem.ui-catalog/1',
    components: UI_CATALOG.map((e) => ({
      ...e,
      exports: [...e.exports],
      library: { ...e.library },
    })),
    tokens: THEME_TOKENS.map((t) => ({ ...t })),
  }
}
