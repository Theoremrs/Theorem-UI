//! The values that cross the composer's boundary: what goes in, what comes
//! out, and the draft that leaves and may come back.

use keybinds::KeyInput;
use serde::{Deserialize, Serialize};
use theorem_workbench_core::{
    Composition, DraftAttachment, ModelChoice, PanelPointer, SourceReference,
};

/// One input for the composer. Pointer positions are in the coordinate space of
/// the area given to [`Composer::resize`](crate::Composer::resize) and `draw`.
#[derive(Clone, Debug)]
pub enum Input {
    Key(KeyInput),
    /// Typed or dictated text from the host's input service.
    Text(String),
    /// Pasted text. Never submits.
    Paste(String),
    Pointer(PanelPointer),
    Composition(Composition),
}

/// What an input did.
#[derive(Debug, Default, PartialEq)]
pub struct Response {
    /// The composer used the input. An unhandled key is the panel's (Esc to
    /// stop a run, Ctrl+C, Tab, the page keys, Alt+[ and Alt+]).
    pub handled: bool,
    pub events: Vec<Event>,
}

/// How a submitted draft goes out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubmitMode {
    /// A new turn.
    Send,
    /// Input to the run that is working.
    Steer,
    /// The loaded message, edited.
    Edit,
}

/// What the composer asks the panel to do. The composer has no effects of its
/// own.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// Enter on a sendable draft. The draft stays until the panel calls
    /// [`Composer::take`](crate::Composer::take).
    Submit {
        text: String,
        /// Ids of the attachments that are `ready`.
        attachments: Vec<String>,
        /// The references still in the text, in text order.
        references: Vec<SourceReference>,
        mode: SubmitMode,
    },
    /// Write `text` to the clipboard.
    Copy {
        text: String,
    },
    /// Write `text` to the clipboard; the composer has already removed it.
    Cut {
        text: String,
    },
    /// Read the clipboard, then send [`Input::Paste`].
    ReadClipboard,
    /// Open the host's file picker.
    AttachPick,
    AttachRemove {
        id: String,
    },
    /// The query after an `@` changed. Answer with
    /// [`Composer::files_found`](crate::Composer::files_found) and this token.
    WantFiles {
        query: String,
        token: u64,
    },
    ModelChosen {
        model_ref: String,
    },
    /// Up on the first line of an empty draft: load the last message through
    /// [`Composer::load_for_edit`](crate::Composer::load_for_edit).
    RecallLast,
}

/// What Enter does now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Policy {
    /// No run is working: Enter sends.
    Idle,
    /// A run is working: Enter steers it when it can take input.
    Running { can_steer: bool },
    /// Nothing can be sent now; the reason is shown.
    Blocked { reason: String },
}

/// What the footer says and what Enter does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComposerStatus {
    pub policy: Policy,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// How much of the model's context the conversation uses, when known.
    pub context_percent: Option<u8>,
}

impl Default for ComposerStatus {
    fn default() -> Self {
        Self {
            policy: Policy::Idle,
            model: None,
            effort: None,
            context_percent: None,
        }
    }
}

/// How the host draws its own caret over the composer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaretPhase {
    /// Drawn and not blinking.
    Steady,
    /// Drawn and blinking: only when focused, idle and motion is allowed.
    Blinking,
    /// Not drawn: the composer does not own input.
    Hidden,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caret {
    /// Column and row in the coordinate space of the drawn area. `None` when
    /// hidden or when the caret's row is not on screen.
    pub cell: Option<(u16, u16)>,
    pub phase: CaretPhase,
}

/// A reference placed in the draft's text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlacedReference {
    /// Unicode scalar offsets of the `@path` text.
    pub start: usize,
    pub end: usize,
    pub reference: SourceReference,
}

/// A draft that left the composer ([`Composer::take`](crate::Composer::take))
/// and may come back ([`Composer::put_back`](crate::Composer::put_back)).
#[derive(Clone, Debug, PartialEq)]
pub struct Draft {
    pub text: String,
    pub anchor: usize,
    pub caret: usize,
    pub references: Vec<PlacedReference>,
    pub attachments: Vec<DraftAttachment>,
    /// The message this draft edits, as it was loaded.
    pub editing: Option<String>,
}

/// The models a popup offers.
pub type Models = Vec<ModelChoice>;
