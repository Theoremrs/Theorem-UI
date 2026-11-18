// SOURCING: none: the public face of `@theorem/spatial`, the library an App
// imports to build an explanation a person can handle. An App's own code
// defines every part (form, meaning, behavior, interaction, structure,
// checks); the parts here are a starting library written the same way.

import type * as THREE from 'three'
import type { PartSpec } from './engine'
import type { Form } from './form'

export { mount } from './view'
export {
  Control,
  hintFor,
  PartAnnotation,
  PartControls,
  PartNote,
  partAnchor,
  PlaybackStrip,
  portAnchor,
  PortTag,
  SpatialChrome,
  Trail,
} from './chrome'
export type {
  ChromeActions,
  ChromeProps,
  ChromeSnapshot,
  PartSnapshot,
  PortSnapshot,
  StateSnapshot,
} from './chrome'
export { Dossier, dossierContext, useDossier } from './dossier'
export type { DossierMessage, DossierState } from './dossier'
export type { MountOptions, PartView, SpatialBuilder, SpatialModel } from './view'
export type {
  CheckSpec,
  ControlSpec,
  HandleSpec,
  PortSpec,
  ShowContext,
  Values,
  Vec3,
} from './engine'
export type { Form } from './form'
export * as parts from './parts'

/** A part as an App writes it: its form is a recipe or a three.js builder, its drawing a three.js object. */
export type Part = PartSpec<Form, THREE.Object3D>

