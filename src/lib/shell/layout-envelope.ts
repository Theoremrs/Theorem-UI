// SOURCING: zod 4 (the envelope's shape, with loose objects so a field a newer
// host added survives a round trip), and Dockview's serialized layout as the
// vendor blob (dockview-core SerializedDockview). The versioned wrapper around
// vendor state, with resource identities and run ids kept outside it, is the
// spec's UI-03 / HOST-01 / OWN-01; no library models it.
import { z } from 'zod'

export const LAYOUT_SCHEMA = 'theorem.layout/1'
const SCHEMA_PREFIX = 'theorem.layout/'
export const LAYOUT_VERSION = 1

/**
 * The host that wrote the envelope. The web host has no release number in the
 * bundle yet, so this names the host and its layout engine; the releases
 * workstream can replace it with the running release id.
 */
export const HOST_VERSION = 'theorem-web/dockview-8'

/** Layouts are kept per presentation: a phone never rewrites the desktop's. */
export type LayoutDevice = 'desktop' | 'narrow'

/** What a panel is, apart from where it sits: its component and parameters. */
const identitySchema = z.looseObject({
  component: z.string(),
  /** Resource identities and run ids the panel was opened with. */
  params: z.record(z.string(), z.unknown()).optional(),
})
export type PanelIdentity = z.infer<typeof identitySchema>

const envelopeSchema = z.looseObject({
  schema: z.literal(LAYOUT_SCHEMA),
  hostVersion: z.string(),
  device: z.string(),
  savedAt: z.string(),
  /** Conversation the layout's artifact panels belong to. */
  threadId: z.string().optional(),
  /** Dockview's serialized state, with each panel's `params` moved to identities. */
  layout: z.looseObject({ panels: z.record(z.string(), z.unknown()) }),
  identities: z.record(z.string(), identitySchema),
})
export type LayoutEnvelope = z.infer<typeof envelopeSchema>

type VendorPanel = { contentComponent?: string; params?: unknown }
export type VendorLayout = { panels: Record<string, VendorPanel> } & Record<
  string,
  unknown
>

/**
 * Wraps a Dockview layout. Each panel's parameters (the artifact, note, file
 * or run it shows) move into `identities`, so the vendor blob holds only
 * geometry and the resource a panel shows is never stored in a library's format.
 */
export function encodeLayout(
  vendor: VendorLayout,
  options: { device: LayoutDevice; threadId?: string; now?: Date },
): LayoutEnvelope {
  const identities: LayoutEnvelope['identities'] = {}
  const panels: Record<string, unknown> = {}
  for (const [id, panel] of Object.entries(vendor.panels)) {
    const { params, ...rest } = panel
    identities[id] = {
      component: panel.contentComponent ?? id,
      ...(params !== undefined && {
        params: params as Record<string, unknown>,
      }),
    }
    panels[id] = rest
  }
  return {
    schema: LAYOUT_SCHEMA,
    hostVersion: HOST_VERSION,
    device: options.device,
    savedAt: (options.now ?? new Date()).toISOString(),
    ...(options.threadId !== undefined && { threadId: options.threadId }),
    layout: { ...vendor, panels },
    identities,
  }
}

export type DecodedLayout =
  | { status: 'ok'; envelope: LayoutEnvelope; vendor: VendorLayout }
  /** Written by a newer host: kept as it is, never rewritten by this one. */
  | { status: 'newer'; raw: unknown; schema: string }
  | { status: 'unreadable'; raw: unknown; reason: string }

/** Puts each panel's identity back, giving Dockview the blob it wrote. */
export function decodeLayout(raw: unknown): DecodedLayout {
  const schema =
    raw && typeof raw === 'object' && 'schema' in raw ? raw.schema : undefined
  if (typeof schema === 'string' && schema.startsWith(SCHEMA_PREFIX)) {
    const number = Number(schema.slice(SCHEMA_PREFIX.length))
    if (Number.isFinite(number) && number > LAYOUT_VERSION)
      return { status: 'newer', raw, schema }
  }
  const parsed = envelopeSchema.safeParse(raw)
  if (!parsed.success)
    return {
      status: 'unreadable',
      raw,
      reason: parsed.error.issues[0]?.message ?? 'not a layout envelope',
    }
  const envelope = parsed.data
  const panels: Record<string, unknown> = {}
  for (const [id, panel] of Object.entries(envelope.layout.panels)) {
    const identity = envelope.identities[id]
    panels[id] = {
      ...(panel as object),
      ...(identity?.params !== undefined && { params: identity.params }),
    }
  }
  return {
    status: 'ok',
    envelope,
    vendor: { ...envelope.layout, panels } as VendorLayout,
  }
}

/** The resource keys and run ids the envelope names, for a recovery listing. */
export const identitiesOf = (envelope: LayoutEnvelope) =>
  Object.entries(envelope.identities).map(([panelId, identity]) => ({
    panelId,
    component: identity.component,
    params: identity.params ?? {},
  }))
