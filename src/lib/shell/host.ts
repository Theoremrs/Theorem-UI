// SOURCING: lib/commands/registry (the platform commands the host registers),
// lib/contributions/registry (the contribution kinds), the single-driver set
// (lib/shell/panel-commands) and the host's layout store. The matrix itself is
// the spec's HOST-02; nothing models it. It describes this web host honestly:
// what it does, and what it declares it does not.
import { useCommandRegistry } from '@/lib/commands/registry'
import { CONTRIBUTION_KINDS } from '@/lib/contributions/registry'
import { LAYOUT_SCHEMA, LAYOUT_VERSION } from './layout-envelope'
import { LAYOUT_STORE_KEY } from './layout-store'
import { SINGLE_DRIVER_COMPONENTS } from './panel-commands'
import { isSafeMode } from './safe-mode'

export const HOST_CAPABILITIES_SCHEMA = 'theorem.host/1'

export interface HostDescription {
  schema: typeof HOST_CAPABILITIES_SCHEMA
  host: 'theorem-web'
  role: string
  safeMode: boolean
  presentationTargets: ReadonlyArray<{
    id: string
    engine: string
    supported: true
    notes?: string
  }>
  layoutEngines: ReadonlyArray<{
    id: string
    purpose: string
    envelope?: string
    singleDriver?: ReadonlyArray<string>
  }>
  storageBindings: ReadonlyArray<{
    id: string
    where: string
    holds: string
    scope: 'person' | 'device' | 'session'
  }>
  openingIntents: ReadonlyArray<{ intent: string; via: string }>
  platformCommands: ReadonlyArray<string>
  contributionKinds: ReadonlyArray<string>
  /** Targets this host does not provide, declared rather than left out (EXT-08). */
  unsupportedTargets: ReadonlyArray<{ id: string; reason: string }>
}

/**
 * The web host's capability matrix: what other hosts, agents and extension
 * authors can rely on here. Platform commands are read from the registry, so
 * the list is what is actually registered, not a copy.
 */
export function describeHost(): HostDescription {
  const commands = [...useCommandRegistry.getState().commands.values()]
    .filter((one) => one.source.kind === 'builtin')
    .map((one) => one.id)
    .sort()
  return {
    schema: HOST_CAPABILITIES_SCHEMA,
    host: 'theorem-web',
    role: 'Reference application: React component catalog, Puck pages, Dockview shell, isolated Apps, owner-backed data and execution adapters.',
    safeMode: isSafeMode(),
    presentationTargets: [
      {
        id: 'dock',
        engine: 'dockview',
        supported: true,
        notes: 'Tabs, splits, floating and maximized groups on wide viewports.',
      },
      {
        id: 'stacked',
        engine: 'dockview',
        supported: true,
        notes:
          'Single-pane presentation on narrow viewports; the desktop arrangement is stored apart.',
      },
      {
        id: 'page',
        engine: 'puck',
        supported: true,
        notes: 'Pages composed of modules.',
      },
      {
        id: 'shell',
        engine: 'react',
        supported: true,
        notes:
          'A selected `shell` contribution replaces navigation, tab chrome, menus and toolbars; recovery and sign-in stay host-owned.',
      },
      { id: 'isolated-app', engine: 'sandboxed-frame', supported: true },
    ],
    layoutEngines: [
      {
        id: 'dockview',
        purpose:
          'Docking, tab groups, floating groups, maximize, serialization.',
        envelope: `${LAYOUT_SCHEMA} (version ${LAYOUT_VERSION}); an unreadable or newer envelope is kept aside, never overwritten`,
        singleDriver: SINGLE_DRIVER_COMPONENTS,
      },
      { id: 'puck', purpose: 'Page composition over modules.' },
    ],
    storageBindings: [
      {
        id: 'handler-preferences',
        where: 'browser storage, theorem.workspace-preferences/1',
        holds: 'Selected default handlers, hidden built-ins, selected shell.',
        scope: 'person',
      },
      {
        id: 'layouts',
        where: `browser storage, ${LAYOUT_STORE_KEY}`,
        holds:
          'Per-viewport layout envelopes; panel identities and run ids kept outside the vendor blob.',
        scope: 'device',
      },
      {
        id: 'failures',
        where: 'browser storage, theorem.failures/1',
        holds: 'Recorded failures of replaceable code.',
        scope: 'device',
      },
      {
        id: 'safe-mode',
        where: 'session storage',
        holds: 'Whether this session started with user extensions off.',
        scope: 'session',
      },
    ],
    openingIntents: [
      {
        intent: 'open-resource',
        via: 'the open-handler contribution chosen by the default-handler order',
      },
      { intent: 'open-panel', via: 'theorem.panel.open' },
      {
        intent: 'focus-existing',
        via: 'a second placement of a single-driver surface offers to focus or move the first',
      },
      { intent: 'recover', via: '/recovery or ?safe=1' },
    ],
    platformCommands: commands,
    contributionKinds: [...CONTRIBUTION_KINDS],
    unsupportedTargets: [
      {
        id: 'native-presentation',
        reason:
          'Native views belong to Platinum and other native hosts; this host renders web presentations only.',
      },
      {
        id: 'headless-presentation',
        reason:
          'Headless clients use generated contracts and capability discovery, not this host.',
      },
      {
        id: 'dockview-enterprise',
        reason:
          'Only the installed public Dockview APIs and licence tier are used; Enterprise features are not included.',
      },
      {
        id: 'shell-without-host-recovery',
        reason:
          'A shell cannot remove recovery, sign-in or authority enforcement; those stay outside it.',
      },
      {
        id: 'multi-driver-conversation',
        reason:
          'The conversation, IDE and terminal keep a single active driver until their owners support more.',
      },
    ],
  }
}
