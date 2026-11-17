//! The Theo message composer of the Web terminal workbench.
//!
//! [`Composer`] is state, `handle`, `draw` and `semantics` over the shared text
//! session and the source editor's widget. It has no effects of its own and no
//! clock: it returns [`Event`]s, and the Theo panel turns them into workbench
//! effects. The hollow caret is the host's: [`Composer::caret`] says where and
//! how, and no caret glyph is ever in the draft.

mod composer;
mod types;
mod view;

pub use composer::{Composer, DEFAULT_HOLD_MS, HISTORY_LIMIT, reference_token};
pub use types::{
    Caret, CaretPhase, ComposerStatus, Draft, Event, Input, Models, PlacedReference, Policy,
    Response, SubmitMode,
};
