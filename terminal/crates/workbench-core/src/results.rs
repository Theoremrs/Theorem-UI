//! Results of the language, run and search owners: the shapes their
//! TypeScript ports (`src/lib/workbench/{language,run,search}/`) answer with,
//! and the types they share.

use serde::{Deserialize, Serialize};

/// LSP position: `line` from 0, `character` counted in UTF-16 code units.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

/// The unit a [`Span`] counts in, spelled as the host sends it
/// (`coordinate_encoding`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum SpanEncoding {
    Utf8Bytes,
    Utf16CodeUnits,
    UnicodeScalars,
}

/// A stretch of a whole document in the host's own units. Turning it into a
/// [`Range`] needs the text it was read against.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Span {
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub start: u64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub end: u64,
    pub encoding: SpanEncoding,
}

/// Which host a result was read from: the workspace, the host's version and
/// epoch, and how many times the owner has seen the workspace reopened.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ReadAt {
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub epoch: Option<String>,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub generation: u64,
}

// ---- language ----------------------------------------------------------

/// `languageHover`. `contents` is Markdown, empty when no provider answered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LanguageHover {
    pub contents: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub range: Option<Range>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub span: Option<Span>,
}

/// Where a completion's text goes: one range, or one for typing at the caret
/// and one for replacing the word around it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(untagged)]
pub enum CompletionRange {
    One(Range),
    Split { inserting: Range, replacing: Range },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CompletionItem {
    pub label: String,
    /// Monaco's `CompletionItemKind` numbering.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub kind: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub documentation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub insert_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub range: Option<CompletionRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub item_id: Option<String>,
}

/// `languageComplete`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LanguageCompletions {
    pub items: Vec<CompletionItem>,
}

/// One place a navigation or a reference points at.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LocationRow {
    /// A document of this workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub resource_id: Option<String>,
    /// A place the host named by URI, outside the workspace's documents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub range: Option<Range>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub span: Option<Span>,
    /// The document revision a span was computed against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "number"))]
    pub revision: Option<u64>,
}

/// `languageNavigate` and `languageReferences`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LanguageLocations {
    pub locations: Vec<LocationRow>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Error,
    Warning,
    Info,
    Hint,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    /// UTF-8 byte offset into the text of the snapshot's `revision`.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub start: u64,
    /// UTF-8 byte offset into the same text, past the last byte.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub end: u64,
    pub severity: Severity,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub fix_handle: Option<String>,
}

/// One finding of a `diagnosticsSet`, placed by line and column. The unit of
/// the columns is the `encoding` the message states once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FindingAt {
    pub range: Range,
    pub severity: Severity,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub code: Option<String>,
}

/// One run the backend lists (`run.list`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub handle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub command: Option<Vec<String>>,
    /// `running` while it runs; another word once it has ended.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "number"))]
    pub started_at_ms: Option<u64>,
    /// How it ended; absent while it runs or when the host does not say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub exit_code: Option<i32>,
    /// The configuration's kind at start (`run`, `test`, ...); a host that
    /// lists no kinds leaves it absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub kind: Option<String>,
}

/// `runList`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RunList {
    pub runs: Vec<RunSummary>,
}

/// `languageDiagnostics`. Every finding's `start` and `end` are UTF-8 byte
/// offsets into the document text at `revision`; a reader holding another
/// revision compares before using them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LanguageDiagnostics {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "number"))]
    pub revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "number"))]
    pub session_epoch: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub content_hash: Option<String>,
    /// True: the findings are the whole set for the document. False: a part.
    pub full: bool,
    pub findings: Vec<Finding>,
}

// ---- run ---------------------------------------------------------------

/// `runPoll`: the host's word for the run, and everything it wrote so far
/// (not only what is new since the last poll).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    pub handle: String,
    /// `running` while it runs; another word once it has ended.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "number"))]
    pub exit_code: Option<i64>,
    pub stdout: String,
    pub stderr: String,
    pub read_at: ReadAt,
}

// ---- search ------------------------------------------------------------

/// A match inside a row's `text`, in UTF-16 code units.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MatchRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SearchRow {
    /// A whole workspace path.
    pub path: String,
    /// From 1, as the host counts lines.
    pub line: u32,
    pub text: String,
    pub matches: Vec<MatchRange>,
    /// UTF-16 code units the host cut from the start of the line before
    /// `text`. A match's column in the file is `textOffset + start`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub text_offset: Option<u32>,
}

/// Where a search stands after a page. `more`: the owner is reading the next
/// page. Every other state is the last page.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SearchState {
    More,
    Complete,
    Cancelled,
    Ended,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SearchEndOutcome {
    Refused,
    Uncertain,
    Failed,
}

/// Why a search ended early; present only with state `ended`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SearchEnd {
    pub outcome: SearchEndOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub code: Option<String>,
    pub reason: String,
}
