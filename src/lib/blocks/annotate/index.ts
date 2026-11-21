// SOURCING: none: what @theorem/annotate offers an App. An App may use any of
// it, copy and change a piece, or write its own: nothing in Theorem requires
// these components.
import '@astryxdesign/core/astryx.css'
import '@astryxdesign/theme-neutral/theme.css'

export { anchorStore, boxAround } from './anchors'
export type { Anchor, AnchorStore, Anchors, Box } from './anchors'
export { Annotation } from './annotation'
export type { AnnotationProps } from './annotation'
export { useAnchor } from './hooks'
export { AnnotationLayer, KeepClear, LEADER_PLACEMENTS, PLACEMENTS } from './layer'
export type { AnnotationLayerProps } from './layer'
export { Glass, GLASS, GLASS_Z, GlassScope } from './glass'
export type { GlassOptions } from './glass'
export { Label, Note } from './note'
export type { LabelProps, NoteProps } from './note'
export { attachOffset, connectorEnds, connectorPath, LEADER_RUN, leaderEnds, subjectPath } from './paths'
export type { Attach, Connector, Point, Subject } from './paths'
export { choose, cost, nearest, overlap } from './place'
export type { Candidate, Placement, PlaceOptions } from './place'
export { Theme } from './theme'
