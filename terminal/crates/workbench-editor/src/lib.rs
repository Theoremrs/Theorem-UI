//! The source editor of the Theo Web terminal workbench.
//!
//! Two layers. [`SourceView`] is the editing widget: it borrows a text session
//! and draws, edits and answers the pointer, with nothing of the document's
//! owner in it, so a second front end (Markdown source mode) can lend its own
//! session. [`EditorPanel`] is the `document` panel: it sends the session's
//! edits to the owner through the core's effects, one in flight and in order,
//! and shows what the owner answers.

mod actions;
mod field;
mod find;
mod owner;
mod panel;
mod styles;
mod sync;
mod tokens;
mod widget;

pub use actions::{Choice, Descriptor, actions, descriptors, extend_registry};
pub use field::Field;
pub use find::Find;
pub use owner::{
    Disk, Held, Level, Note, Owed, OwnerSync, Restored, Saving, Step, Unknown, revision_number,
};
pub use panel::{Drafts, EditorPanel, KIND, register, register_with};
pub use styles::EditorStyles;
pub use sync::{Changed, apply_owner_change, resync, step_before};
pub use tokens::TokenState;
pub use widget::{Clipboard, Mark, PASTE_LIMIT, Paint, Position, Reaction, SourceView};
