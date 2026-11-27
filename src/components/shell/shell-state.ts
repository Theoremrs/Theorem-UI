// SOURCING: zustand + zustand/middleware persist (per-browser shell preferences; durable data stays in Theorem)
import type { SerializedDockview } from 'dockview-react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  Attachment,
  Companion,
  PlacementChoice,
} from '@/components/workbench/placement'
import type { NoteOrder } from '@/lib/theorem/note-order'
import type { ShellMode } from './modes'

/** A project's desktop dock arrangement. */
export type SavedLayout = {
  /** Conversation the layout's artifact panels belong to. */
  threadId: string | undefined
  dock: SerializedDockview
}

/** One tab of the right-hand terminal: its own agent thread, made on its first turn. */
export type TerminalTab = { id: string; title: string; threadId?: string }

/** What the right-hand drawer shows; only the terminal so far. */
export type SideDrawer = 'terminal' | 'outputs'

/**
 * The navigation panel's working range in px; it opens at the default. This
 * is the one place a sidebar's width is set: the phone drawer and the settings
 * sidebar take the default from here too.
 */
export const PANEL_WIDTH = { min: 184, default: 240, max: 420 } as const

/** Defaults before version 10 (354 before 7, 280 in 7, 248 in 8, 210 in 9): a panel still at one was never dragged. */
const OLD_PANEL_WIDTHS: readonly number[] = [354, 280, 248, 210]

type ShellState = {
  /** Project whose threads the sidebar lists. Falls back to the first project. */
  projectId: string | undefined
  /** Desktop dock layouts by project. Phones use a drawer instead. */
  layouts: Readonly<Record<string, SavedLayout>>
  /** Desktop context panel width, shared by every mode. */
  panelWidth: number
  /** Modes whose context panel the user has closed; each starts open. */
  panelCollapsed: Readonly<Partial<Record<ShellMode, boolean>>>
  /**
   * The rail's destinations in the order the person dragged them into. Empty
   * until they move one; modes it does not name keep their default place.
   */
  railOrder: readonly ShellMode[]
  /**
   * Whether the navigator shows the files in full, over the mode's own list.
   * The rail's Files control reveals them; nothing navigates away. Kept for
   * the visit only, so a reload opens each mode on its own list.
   */
  filesShown: boolean
  /**
   * Conversation chat mode last showed; undefined for a new chat. Spaces and
   * the IDE keep it open behind them, so switching back returns to it. Not
   * persisted: a reload starts from the URL.
   */
  chatThreadId: string | undefined
  /** Whether the chat panel's file explorer is expanded. */
  explorerOpen: boolean
  /** Whether Theia's own side panel (its explorer) is open in the IDE. */
  ideFilesOpen: boolean
  /** Which quick views and projects a person opened or closed in the sidebar. */
  organizeOpen: Readonly<Record<string, boolean>>
  /** The IDE panel's Files height in px, set by dragging the line above it. Unset, Files takes half. */
  ideFilesHeight?: number
  /**
   * The sidebar's projects in the order the person dragged them into. Empty
   * until they move one; projects it does not name follow, as Theorem lists them.
   */
  projectOrder: readonly string[]
  /**
   * Where the person put the workbench: full screen, docked beside or under
   * the sheet, or closed. Unset until they choose, when the delivery switch
   * decides (components/workbench/placement.ts).
   */
  workbench: PlacementChoice | undefined
  /** Whether the workbench beside or under the conversation is a drawer over it or part of the screen (Settings, Appearance). */
  workbenchAttachment: Attachment
  /** The docked placement last used, which a toggle reopens. */
  lastCompanion: Companion
  /** The workbench docked under the sheet: its height as a share of the window. */
  terminalHeight: number
  /** Each project's current agent-terminal thread. */
  terminalThreads: Readonly<Record<string, string>>
  /** Every thread the terminal has made, kept out of the chat list. */
  terminalThreadIds: readonly string[]
  /** What the right-hand drawer shows, when it is open. Not persisted. */
  sideDrawer: SideDrawer | undefined
  /** The workbench docked beside the sheet: its width in px, set by dragging its edge. */
  sideWidth: number
  /**
   * The docked artifact cabinet's width in px, set by dragging its edge
   * (SPEC-THEOREM-ARTIFACT-CABINET-1.0 §4.2 targets 466).
   */
  cabinetWidth: number
  /** Whether the cabinet uses the whole workspace (§4.3). Not persisted. */
  cabinetExpanded: boolean
  /**
   * The artifact the Gallery was asked to show, until its card is selected
   * there. Not persisted.
   */
  galleryArtifact: string | undefined
  /** Each project's right-hand terminal tabs, in order, and the one showing. */
  terminalTabs: Readonly<
    Record<string, { tabs: readonly TerminalTab[]; active: string }>
  >
  /** The order Notes mode lists notes in. */
  noteOrder: NoteOrder
  /**
   * The project a thread was asked to open under (its row under that project
   * was picked in the workbench's Threads panel). It holds until another
   * thread opens.
   */
  askedProject: { threadId: string; projectId: string } | undefined
  setProjectId: (projectId: string) => void
  askProject: (
    asked: { threadId: string; projectId: string } | undefined,
  ) => void
  setNoteOrder: (order: NoteOrder) => void
  saveLayout: (projectId: string, layout: SavedLayout) => void
  setPanelWidth: (width: number) => void
  togglePanel: (mode: ShellMode) => void
  setPanelOpen: (mode: ShellMode, open: boolean) => void
  setRailOrder: (order: readonly ShellMode[]) => void
  setFilesShown: (shown: boolean) => void
  setChatThreadId: (threadId: string | undefined) => void
  toggleExplorer: () => void
  setIdeFilesOpen: (open: boolean) => void
  setOrganizeOpen: (key: string, open: boolean) => void
  setIdeFilesHeight: (height: number) => void
  setProjectOrder: (order: readonly string[]) => void
  /** Puts the workbench somewhere, or closes it; a docked placement becomes the one a toggle reopens. */
  setWorkbench: (choice: PlacementChoice) => void
  setWorkbenchAttachment: (attachment: Attachment) => void
  setTerminalHeight: (height: number) => void
  setTerminalThread: (projectId: string, threadId: string | undefined) => void
  setSideDrawer: (drawer: SideDrawer | undefined) => void
  /** Opens the drawer's Gallery on an artifact's card. */
  openInGallery: (artifactId: string) => void
  /** The Gallery selected the card it was asked to show. */
  shownInGallery: () => void
  setSideWidth: (width: number) => void
  setCabinetWidth: (width: number) => void
  setCabinetExpanded: (expanded: boolean) => void
  openTerminalTab: (projectId: string) => void
  closeTerminalTab: (projectId: string, tabId: string) => void
  selectTerminalTab: (projectId: string, tabId: string) => void
  /** Records a tab's thread and title, or clears its thread so it starts over. */
  updateTerminalTab: (
    projectId: string,
    tabId: string,
    change: { threadId: string | undefined; title?: string },
  ) => void
}

const newTab = (): TerminalTab => ({
  id: crypto.randomUUID(),
  title: 'agent',
})

export const useShell = create<ShellState>()(
  persist(
    (set) => ({
      projectId: undefined,
      askedProject: undefined,
      layouts: {},
      panelWidth: PANEL_WIDTH.default,
      panelCollapsed: {},
      railOrder: [],
      filesShown: false,
      noteOrder: 'edited',
      chatThreadId: undefined,
      explorerOpen: false,
      ideFilesOpen: true,
      organizeOpen: {},
      projectOrder: [],
      workbench: undefined,
      workbenchAttachment: 'drawer',
      lastCompanion: 'side',
      terminalHeight: 0.42,
      terminalThreads: {},
      terminalThreadIds: [],
      sideDrawer: undefined,
      sideWidth: 620,
      cabinetWidth: 466,
      cabinetExpanded: false,
      galleryArtifact: undefined,
      terminalTabs: {},
      setNoteOrder: (noteOrder) => set({ noteOrder }),
      setProjectId: (projectId) => set({ projectId }),
      askProject: (askedProject) => set({ askedProject }),
      saveLayout: (projectId, layout) =>
        set((s) => ({ layouts: { ...s.layouts, [projectId]: layout } })),
      setPanelWidth: (panelWidth) => set({ panelWidth }),
      togglePanel: (mode) =>
        set((s) => ({
          panelCollapsed: {
            ...s.panelCollapsed,
            [mode]: !s.panelCollapsed[mode],
          },
        })),
      setPanelOpen: (mode, open) =>
        set((s) => ({
          panelCollapsed: { ...s.panelCollapsed, [mode]: !open },
        })),
      setRailOrder: (railOrder) => set({ railOrder }),
      setFilesShown: (filesShown) => set({ filesShown }),
      setChatThreadId: (chatThreadId) => set({ chatThreadId }),
      toggleExplorer: () => set((s) => ({ explorerOpen: !s.explorerOpen })),
      setIdeFilesOpen: (ideFilesOpen) => set({ ideFilesOpen }),
      setOrganizeOpen: (key, open) =>
        set((s) => ({ organizeOpen: { ...s.organizeOpen, [key]: open } })),
      setIdeFilesHeight: (ideFilesHeight) => set({ ideFilesHeight }),
      setProjectOrder: (projectOrder) => set({ projectOrder }),
      setWorkbench: (workbench) =>
        set(
          workbench === 'side' || workbench === 'bottom'
            ? { workbench, lastCompanion: workbench }
            : { workbench },
        ),
      setWorkbenchAttachment: (workbenchAttachment) =>
        set({ workbenchAttachment }),
      setTerminalHeight: (terminalHeight) => set({ terminalHeight }),
      setTerminalThread: (projectId, threadId) =>
        set((s) => {
          const { [projectId]: _, ...rest } = s.terminalThreads
          if (!threadId) return { terminalThreads: rest }
          return {
            terminalThreads: { ...rest, [projectId]: threadId },
            terminalThreadIds: s.terminalThreadIds.includes(threadId)
              ? s.terminalThreadIds
              : [...s.terminalThreadIds, threadId],
          }
        }),
      setSideDrawer: (sideDrawer) => set({ sideDrawer }),
      openInGallery: (galleryArtifact) =>
        set({ sideDrawer: 'outputs', galleryArtifact }),
      shownInGallery: () => set({ galleryArtifact: undefined }),
      setSideWidth: (sideWidth) => set({ sideWidth }),
      setCabinetWidth: (cabinetWidth) => set({ cabinetWidth }),
      setCabinetExpanded: (cabinetExpanded) => set({ cabinetExpanded }),
      openTerminalTab: (projectId) =>
        set((s) => {
          const tab = newTab()
          const tabs = s.terminalTabs[projectId]?.tabs ?? []
          return {
            terminalTabs: {
              ...s.terminalTabs,
              [projectId]: { tabs: [...tabs, tab], active: tab.id },
            },
          }
        }),
      closeTerminalTab: (projectId, tabId) =>
        set((s) => {
          const current = s.terminalTabs[projectId]
          if (!current) return {}
          const at = current.tabs.findIndex((tab) => tab.id === tabId)
          const rest = current.tabs.filter((tab) => tab.id !== tabId)
          // The last tab closing leaves a fresh one, as a terminal would.
          const tabs = rest.length ? rest : [newTab()]
          const active =
            current.active === tabId
              ? (tabs[Math.min(at, tabs.length - 1)]?.id ?? '')
              : current.active
          return {
            terminalTabs: { ...s.terminalTabs, [projectId]: { tabs, active } },
          }
        }),
      selectTerminalTab: (projectId, tabId) =>
        set((s) => {
          const current = s.terminalTabs[projectId]
          if (!current?.tabs.some((tab) => tab.id === tabId)) return {}
          return {
            terminalTabs: {
              ...s.terminalTabs,
              [projectId]: { ...current, active: tabId },
            },
          }
        }),
      updateTerminalTab: (projectId, tabId, { threadId, title }) =>
        set((s) => {
          const current = s.terminalTabs[projectId]
          if (!current) return {}
          const tabs = current.tabs.map((tab) =>
            tab.id === tabId
              ? { ...tab, threadId, title: title ?? tab.title }
              : tab,
          )
          return {
            terminalTabs: {
              ...s.terminalTabs,
              [projectId]: { ...current, tabs },
            },
            terminalThreadIds:
              !threadId || s.terminalThreadIds.includes(threadId)
                ? s.terminalThreadIds
                : [...s.terminalThreadIds, threadId],
          }
        }),
    }),
    {
      name: 'theorem-ui:shell',
      // Version 0 kept a sidebarOpen flag that the dock's edge group replaced,
      // and version 1 docked the sidebar in that edge group. The sidebar now
      // sits beside the dock, so older layouts are dropped rather than restored
      // with a panel the dock no longer has. Version 3 narrowed the panel's
      // range, so widths saved against the wider one start over at the default.
      // Version 3 kept filesShown, which now lasts only for the visit. Version 4
      // (on main) dropped it; version 4 (on the canvas branch) widened the panel
      // for the project tree and folded the files away. Version 5 does both for
      // whichever version 4 a layout was saved under. Version 6 gave the IDE
      // its own panel beside the rail: the IDE's collapsed flag had meant
      // Theia's explorer, so it moves to ideFilesOpen and the panel opens.
      // Versions 7 to 10 moved the default width: a panel left at an old
      // default takes the new one, and a width the person dragged to is kept.
      // Version 9 was the cabinet spec's 210px navigation; version 10 opens at
      // 240px, where the owner's review on 2026-11-15 found 210 cut thread
      // titles short.
      version: 10,
      partialize: ({
        projectId,
        layouts,
        panelWidth,
        panelCollapsed,
        railOrder,
        explorerOpen,
        ideFilesOpen,
        organizeOpen,
        ideFilesHeight,
        projectOrder,
        workbench,
        workbenchAttachment,
        lastCompanion,
        terminalHeight,
        sideWidth,
        cabinetWidth,
        terminalThreads,
        terminalThreadIds,
        terminalTabs,
        noteOrder,
      }) => ({
        projectId,
        layouts,
        panelWidth,
        panelCollapsed,
        railOrder,
        explorerOpen,
        ideFilesOpen,
        organizeOpen,
        ideFilesHeight,
        projectOrder,
        workbench,
        workbenchAttachment,
        lastCompanion,
        terminalHeight,
        sideWidth,
        cabinetWidth,
        terminalThreads,
        terminalThreadIds,
        terminalTabs,
        noteOrder,
      }),
      migrate: (persisted, version) => {
        const state = persisted as Partial<ShellState> | undefined
        const { ide, ...collapsed } = state?.panelCollapsed ?? {}
        const theia = { panelCollapsed: collapsed, ideFilesOpen: !ide }
        const panelWidth =
          state?.panelWidth !== undefined &&
          OLD_PANEL_WIDTHS.includes(state.panelWidth)
            ? PANEL_WIDTH.default
            : state?.panelWidth
        if (version >= 6 && version <= 9) return { ...state, panelWidth }
        if (version === 5) return { ...state, ...theia, panelWidth }
        if (version >= 2 && version <= 4) {
          const { filesShown: _, ...kept } = (state ?? {}) as ShellState
          return {
            ...kept,
            ...theia,
            panelWidth: PANEL_WIDTH.default,
            explorerOpen: false,
          }
        }
        return { projectId: state?.projectId, layouts: {} }
      },
    },
  ),
)
