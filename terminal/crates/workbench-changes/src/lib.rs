//! The Changes (source control) model and view for the Theo Web terminal workbench.
//!
//! A translation of the ELY source-control panel into Ratatui terms. The model never
//! performs I/O: a user action returns an [`Intent`] describing what to ask the SCM
//! owner for, tagged with the repository generation it was decided against, and the
//! owner's answer is applied with [`Changes::complete`]. It knows nothing of the `Panel`
//! trait; a later work order wraps it.
//!
//! Translated from ELY-Open-Source/ELYTerminal at fbb536ec8f6e1466fa8c736967671ebf99a34080
//! and ELY-Open-Source/Ely-GPUI-Components at 294a8323c08a06bd8e7782d16acee43b6bb0c5eb
//! (both MIT; see `LICENSE-ELY` and the header of each file).

mod delegation;
mod descriptors;
mod diff;
mod documents;
mod draw;
mod intent;
mod layout;
mod model;
mod panel;
mod semantics;
mod status;
mod styles;
mod text;
mod view_state;

pub use delegation::{
    DelegationPanel, MAX_LINE_CHARS, MAX_LISTED, MAX_SIDE_BYTES, MAX_SIDE_LINES,
    actions as delegation_actions, descriptor as delegation_descriptor,
};
pub use descriptors::{descriptors, extend_registry};
pub use diff::{
    DiffLine, Hunk, LineKind, ParseError, Parsed, mark_words, pair_places, pairs, parse,
    side_numbers,
};
pub use documents::{Landed, OpenDocument, Receipt};
pub use draw::SPLIT_MIN;
pub use intent::{ActionKind, Intent, IntentId, IntentKind, Refusal, Side};
pub use model::{
    BranchList, Caret, Changes, Confirm, Counters, DiffLayout, DiffState, DiffView, Field, Focus,
    LogState, Mode, Notice, PanelState, Problem, Prompt, PromptKind, RECENT, ReadBody, ReadKind,
    ReadView, SUBJECT,
};
pub use panel::{ChangesPanel, KIND, REPOSITORY, register};
pub use semantics::actions;
pub use status::{
    Basis, Change, Groups, Head, LISTED, Loss, RowKey, Section, is_folder, letter, loss, shown,
};
pub use styles::ChangesStyles;
pub use view_state::{VERSION, ViewState};
