// SOURCING: Astryx (`@astryxdesign/core` and `@astryxdesign/theme-neutral`,
// MIT, Meta Platforms, Inc.) in Theorem's theme: what @theorem/ui offers an
// App. An App may use any of it, copy and change a piece, import Astryx
// itself, or write its own; nothing in Theorem requires these components.
//
// The controls that take a value or a press also take `control`, which names
// them for the agent (reach.ts). Astryx's Tooltip is not offered: a value
// shows as text.
import '@astryxdesign/core/astryx.css'
import '@astryxdesign/theme-neutral/theme.css'

export { Theme } from './theme'
export {
  Button,
  CheckboxInput,
  NumberInput,
  SegmentedControl,
  Selector,
  Slider,
  Switch,
  TextInput,
  ToggleButton,
} from './controls'
export { useControl } from './reach'
export type { ControlKind, ControlSpec, Reach } from './reach'
export { Dock, DockRow, Stage } from './stage'
export type { DockProps, StageProps } from './stage'
export { mount } from './mount'

// Astryx's own, unchanged: layout, text and the pieces around a control.
export { Badge } from '@astryxdesign/core/Badge'
export { Card } from '@astryxdesign/core/Card'
export { Divider } from '@astryxdesign/core/Divider'
export { Field } from '@astryxdesign/core/Field'
export { HStack } from '@astryxdesign/core/HStack'
export { IconButton } from '@astryxdesign/core/IconButton'
export { Kbd } from '@astryxdesign/core/Kbd'
export { ProgressBar } from '@astryxdesign/core/ProgressBar'
export { SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
export { Spinner } from '@astryxdesign/core/Spinner'
export { Stack } from '@astryxdesign/core/Stack'
export { Heading, Text } from '@astryxdesign/core/Text'
export { ToggleButtonGroup } from '@astryxdesign/core/ToggleButton'
export { VStack } from '@astryxdesign/core/VStack'
