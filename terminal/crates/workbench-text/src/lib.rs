//! Text foundation for the Theo Web terminal workbench: coordinate
//! conversions and the one editing session that the composer, the source
//! editor and Markdown source editing share.
//!
//! * [`coords`]: bytes, UTF-16, scalars, lines, graphemes and display cells.
//! * [`EditSession`]: text, cursor, selection, undo, atomic ranges, IME
//!   composition, and the exchange of changes with the document owner.
//! * [`recovery`]: the words and decisions for local state, recovered edits
//!   and revoked access that every panel over a document shares.
//! * [`render`]: draw a session into a ratatui buffer.
//!
//! The crate is pure Rust with no terminal backend and no browser bindings,
//! so it runs in tests on the host and builds for `wasm32-unknown-unknown`.

pub mod change;
pub mod coords;
mod history;
pub mod layout;
pub mod recovery;
pub mod render;
pub mod session;

pub use change::{ChangeError, ScalarChange, TextChange};
pub use coords::{Coords, LineCol, Snap, Unit};
pub use render::{Caret, EditorStyles, RenderOptions, Rendered, render};
pub use session::{
    AtomicError, AtomicId, AtomicRange, Conflict, Deletion, Display, EditError, EditSession,
    LocalEdit, Motion, Newlines, OpId, PasteOptions, PendingEdit, PendingState, RemoteApplied,
    Resolution, Revision, Scroll, SessionConfig, SyncError, ViewSnapshot,
};
