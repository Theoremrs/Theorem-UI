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
];

fn withhold(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, inner) in map.iter_mut() {
                match inner {
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
    ArtifactContent, BlameHunk, ClipboardText, ConflictSides, DiffHunk, DocumentCurrent,
    DocumentOpened, DocumentReconciled, DocumentSnapshot, LogEntry, ScmDiffResult, ScmShowResult,
};
use crate::draft::SourceReference;
use crate::effect::{
    ClipboardWrite, ConversationEdit, ConversationInput, ConversationSend, DocumentCreate,
    DocumentKeep, DocumentOpen, FilesSearch, KeptEdit, ScmAmend, ScmCommit, ScmResolve,
    SearchQuery, TerminalInput, TerminalInputBytes, TextChange,
};
use crate::host::HostMessage;
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
