//! VT byte-to-screen interpreter, ratatui renderer and input encoder for the
//! process panes of the Theo Web terminal workbench.
//!
//! The interpreter is `vt100` 0.16 (the same one the workspace host uses to
//! build its `formatted` repaint), drawn through `tui-term`. Nothing here
//! talks to a network or the browser: bytes in, cells and bytes out.

mod buffer;
mod input;
mod screen;
mod view;

pub use buffer::{Pos, SelectionKind, Span};
pub use input::{InputModes, encode_focus, encode_key, encode_mouse, encode_paste};
pub use screen::{OffsetGap, SCROLLBACK_LINES, Screen};
pub use tui_term::widget::CursorShape;
pub use view::{Palette, TerminalView};
pub use vt100::{MouseProtocolEncoding, MouseProtocolMode};
