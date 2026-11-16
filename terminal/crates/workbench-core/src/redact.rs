//! Debug that keeps content out of reports (R42). An effect or a completion
//! printed with `{:?}` shows its kind and identities (ids, resources,
//! revisions, generation, actor) and, for what a person or a program wrote
//! (document text, commit messages, terminal bytes, a message to Theo), only a
//! size: `<N bytes withheld>`. Serialization is untouched.
//!
//! The payloads that carry content implement `Debug` through [`withhold!`]: the
//! value is read through its own wire form and every string under one of
//! [`CONTENT_KEYS`], however deep, is replaced by its size.

use std::fmt;

use serde::Serialize;
use serde_json::Value;

/// Wire field names that hold content rather than an identity.
const CONTENT_KEYS: &[&str] = &[
    "insert",
    "seedText",
    "message",
    "text",
    "query",
    "bytes",
    "data",
    "patch",
    "header",
    "subject",
    "body",
    "base",
    "ours",
    "theirs",
    "excerpt",
    "summary",
    "snapshot",
    "contents",
    "documentation",
    "insertText",
    "detail",
    "stdout",
    "stderr",
    "point",
];

fn withhold(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, inner) in map.iter_mut() {
                match inner {
                    // A program's own status: its state stays, its text is a size.
                    Value::Object(status) if key == "status" && status.contains_key("state") => {
                        withhold_status(status)
                    }
                    Value::String(s) if CONTENT_KEYS.contains(&key.as_str()) => {
                        *inner = Value::String(format!("<{} bytes withheld>", s.len()));
                    }
                    _ => withhold(inner),
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(withhold),
        _ => {}
    }
}

/// A program status object: every string but `state` becomes its size.
fn withhold_status(status: &mut serde_json::Map<String, Value>) {
    for (key, inner) in status.iter_mut() {
        if let (Value::String(s), true) = (&*inner, key != "state") {
            *inner = Value::String(format!("<{} bytes withheld>", s.len()));
        }
    }
}

/// The `Debug` of a value that may carry content.
pub(crate) fn fmt_withholding<T: Serialize>(
    name: &str,
    value: &T,
    f: &mut fmt::Formatter<'_>,
) -> fmt::Result {
    let Ok(mut wire) = serde_json::to_value(value) else {
        return write!(f, "{name} {{ .. }}");
    };
    withhold(&mut wire);
    let shown = if f.alternate() {
        serde_json::to_string_pretty(&wire)
    } else {
        serde_json::to_string(&wire)
    };
    write!(f, "{name} {}", shown.unwrap_or_default())
}

macro_rules! withhold {
    ($($ty:ty),* $(,)?) => {$(
        impl fmt::Debug for $ty {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                fmt_withholding(stringify!($ty), self, f)
            }
        }
    )*};
}

use crate::completion::{
    ArtifactContent, BlameHunk, ClipboardText, ConflictSides, DelegationText, DiffHunk,
    DocumentCurrent, DocumentHistory, DocumentOpened, DocumentPreview, DocumentReconciled,
    DocumentSnapshot, LogEntry, ScmDiffResult, ScmShowResult,
};
use crate::draft::SourceReference;
use crate::effect::{
    ClipboardWrite, ConversationEdit, ConversationInput, ConversationSend, DocumentCreate,
    DocumentKeep, DocumentOpen, FilesSearch, KeptEdit, ScmAmend, ScmCommit, ScmResolve,
    SearchQuery, TerminalInput, TerminalInputBytes, TextChange,
};
use crate::host::{HostMessage, ProgramStatus};
use crate::msg::Msg;
use crate::panel::{Composition, PanelMsg};
use crate::picker::PickerMsg;
use crate::results::{CompletionItem, Finding, FindingAt, LanguageHover, RunState, SearchRow};

withhold!(
    TextChange,
    DocumentKeep,
    KeptEdit,
    DocumentCreate,
    DocumentOpen,
    ScmCommit,
    ScmAmend,
    ScmResolve,
    FilesSearch,
    SearchQuery,
    TerminalInput,
    TerminalInputBytes,
    ConversationSend,
    ConversationInput,
    ConversationEdit,
    ClipboardWrite,
    SourceReference,
    DocumentSnapshot,
    DocumentHistory,
    DocumentPreview,
    DelegationText,
    DocumentOpened,
    DocumentCurrent,
    DocumentReconciled,
    DiffHunk,
    ScmDiffResult,
    ScmShowResult,
    LogEntry,
    BlameHunk,
    ConflictSides,
    ClipboardText,
    ArtifactContent,
    HostMessage,
    LanguageHover,
    CompletionItem,
    Finding,
    FindingAt,
    RunState,
    SearchRow,
);

impl fmt::Debug for ProgramStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Ok(Value::Object(mut wire)) = serde_json::to_value(self) else {
            return write!(f, "ProgramStatus {{ .. }}");
        };
        withhold_status(&mut wire);
        let wire = Value::Object(wire);
        let shown = if f.alternate() {
            serde_json::to_string_pretty(&wire)
        } else {
            serde_json::to_string(&wire)
        };
        write!(f, "ProgramStatus {}", shown.unwrap_or_default())
    }
}

/// `<N bytes withheld>`: the size of typed, pasted or streamed content.
struct Size(usize);

impl fmt::Debug for Size {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "<{} bytes withheld>", self.0)
    }
}

/// A key as the class of key it is: a character key is a character, never
/// which one (a password is typed this way).
struct KeyShape<'a>(&'a keybinds::KeyInput);

impl fmt::Debug for KeyShape<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let key = self.0.key();
        let mods = self.0.mods();
        match key {
            keybinds::Key::Char(_) => write!(f, "Char(<withheld>) {mods:?}"),
            other => write!(f, "{other:?} {mods:?}"),
        }
    }
}

impl fmt::Debug for Composition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Start => f.write_str("Start"),
            Self::Update { text } => f
                .debug_struct("Update")
                .field("text", &Size(text.len()))
                .finish(),
            Self::End { text } => f
                .debug_struct("End")
                .field("text", &Size(text.len()))
                .finish(),
        }
    }
}

impl fmt::Debug for PickerMsg {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Open => f.write_str("Open"),
            Self::Rest => f.write_str("Rest"),
            Self::Take => f.write_str("Take"),
            Self::Back => f.write_str("Back"),
            Self::Close => f.write_str("Close"),
            Self::Filter(text) => f.debug_tuple("Filter").field(&Size(text.len())).finish(),
            Self::Next => f.write_str("Next"),
            Self::Prev => f.write_str("Prev"),
            Self::Left => f.write_str("Left"),
            Self::Right => f.write_str("Right"),
            Self::Choose => f.write_str("Choose"),
            Self::Select(n) => f.debug_tuple("Select").field(n).finish(),
            Self::ChooseAt(n) => f.debug_tuple("ChooseAt").field(n).finish(),
            Self::ChooseRow(id) => f.debug_tuple("ChooseRow").field(id).finish(),
            Self::Layouts => f.write_str("Layouts"),
            Self::Presentations => f.write_str("Presentations"),
            Self::SaveAs => f.write_str("SaveAs"),
            Self::RenameSelected => f.write_str("RenameSelected"),
            Self::DeleteSelected => f.write_str("DeleteSelected"),
            Self::TogglePin => f.write_str("TogglePin"),
            Self::TogglePinAt(n) => f.debug_tuple("TogglePinAt").field(n).finish(),
        }
    }
}

/// The task or words an agent sends are content: their size is printed,
/// never the text. The option is a word from a fixed set.
impl fmt::Debug for crate::agent::ActionArgs {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ActionArgs")
            .field("input", &self.input.as_ref().map(|t| Size(t.len())))
            .field("option", &self.option.as_ref().map(|o| Size(o.len())))
            .finish()
    }
}

impl fmt::Debug for Msg {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Key(key) => f.debug_tuple("Key").field(&KeyShape(key)).finish(),
            Self::Pointer(p) => f.debug_tuple("Pointer").field(p).finish(),
            Self::Text(text) => f.debug_tuple("Text").field(&Size(text.len())).finish(),
            Self::Paste(text) => f.debug_tuple("Paste").field(&Size(text.len())).finish(),
            Self::Composition(c) => f.debug_tuple("Composition").field(c).finish(),
            Self::Resize { area, metrics } => f
                .debug_struct("Resize")
                .field("area", area)
                .field("metrics", metrics)
                .finish(),
            Self::Focus(on) => f.debug_tuple("Focus").field(on).finish(),
            Self::ReducedMotion(on) => f.debug_tuple("ReducedMotion").field(on).finish(),
            Self::Host(m) => f.debug_tuple("Host").field(m).finish(),
            Self::Completion(c) => f.debug_tuple("Completion").field(c).finish(),
            Self::Action { id, actor } => f
                .debug_struct("Action")
                .field("id", id)
                .field("actor", actor)
                .finish(),
            Self::ActionOn { id, actor, panel } => f
                .debug_struct("ActionOn")
                .field("id", id)
                .field("actor", actor)
                .field("panel", panel)
                .finish(),
            Self::ActionWith {
                id,
                actor,
                panel,
                args,
            } => f
                .debug_struct("ActionWith")
                .field("id", id)
                .field("actor", actor)
                .field("panel", panel)
                .field("args", args)
                .finish(),
            Self::Picker(m) => f.debug_tuple("Picker").field(m).finish(),
            Self::Dock(m) => f.debug_tuple("Dock").field(m).finish(),
            Self::Arrangement(m) => f.debug_tuple("Arrangement").field(m).finish(),
            Self::Tick => f.write_str("Tick"),
        }
    }
}

impl fmt::Debug for PanelMsg {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Key(key) => f.debug_tuple("Key").field(&KeyShape(key)).finish(),
            Self::Text(text) => f.debug_tuple("Text").field(&Size(text.len())).finish(),
            Self::Paste(text) => f.debug_tuple("Paste").field(&Size(text.len())).finish(),
            Self::Composition(c) => f.debug_tuple("Composition").field(c).finish(),
            Self::Pointer(p) => f.debug_tuple("Pointer").field(p).finish(),
            Self::Resize { area, metrics } => f
                .debug_struct("Resize")
                .field("area", area)
                .field("metrics", metrics)
                .finish(),
            Self::Focus(on) => f.debug_tuple("Focus").field(on).finish(),
            Self::Completion(c) => f.debug_tuple("Completion").field(c).finish(),
            Self::Cached(c) => f.debug_tuple("Cached").field(c).finish(),
            Self::Host(m) => f.debug_tuple("Host").field(m).finish(),
            Self::TerminalOutput {
                epoch,
                offset,
                bytes,
            } => f
                .debug_struct("TerminalOutput")
                .field("epoch", epoch)
                .field("offset", offset)
                .field("bytes", &Size(bytes.len()))
                .finish(),
            Self::TerminalReset {
                epoch,
                offset,
                formatted,
            } => f
                .debug_struct("TerminalReset")
                .field("epoch", epoch)
                .field("offset", offset)
                .field("formatted", &Size(formatted.len()))
                .finish(),
            Self::TerminalResetRequest { frames, bytes } => f
                .debug_struct("TerminalResetRequest")
                .field("frames", frames)
                .field("bytes", bytes)
                .finish(),
            Self::Documents(list) => f.debug_tuple("Documents").field(list).finish(),
            Self::Reference(r) => f.debug_tuple("Reference").field(r).finish(),
            Self::TerminalReport(report) => f.debug_tuple("TerminalReport").field(report).finish(),
            Self::Action(id) => f.debug_tuple("Action").field(id).finish(),
            Self::Switch { project, thread } => f
                .debug_struct("Switch")
                .field("project", &Size(project.len()))
                .field("thread", &Size(thread.len()))
                .finish(),
            Self::Workspace(w) => f.debug_tuple("Workspace").field(w).finish(),
            Self::Motion { reduced } => f.debug_struct("Motion").field("reduced", reduced).finish(),
            Self::RevealOffset { start, unit } => f
                .debug_struct("RevealOffset")
                .field("start", start)
                .field("unit", unit)
                .finish(),
            Self::Reveal { line, column } => f
                .debug_struct("Reveal")
                .field("line", line)
                .field("column", column)
                .finish(),
            Self::Tick => f.write_str("Tick"),
        }
    }
}
