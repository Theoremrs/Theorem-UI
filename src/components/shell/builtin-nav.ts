// SOURCING: the rail's marks (rail-marks). The shipped destinations as plain
// data, kept apart from the mode views so settings and recovery can list them
// without loading the Thread, the canvas or the IDE.
import { RailMark } from './rail-marks'

/** The rail's destinations, in order. */
export const MODES = [
  { mode: 'chat', label: 'Home', Mark: RailMark.Home },
  { mode: 'index', label: 'Index', Mark: RailMark.Index },
  { mode: 'notes', label: 'Notes', Mark: RailMark.Notes },
  { mode: 'pages', label: 'Pages', Mark: RailMark.Pages },
  // The Vault works on Home and the opened folders; the rail offers it while
  // there are any.
  { mode: 'vault', label: 'Vault', Mark: RailMark.Vault, folders: true },
  { mode: 'spaces', label: 'Spaces', Mark: RailMark.Spaces },
  { mode: 'canvas', label: 'Canvas', Mark: RailMark.Canvas },
  { mode: 'ide', label: 'IDE', Mark: RailMark.Ide },
] as const
