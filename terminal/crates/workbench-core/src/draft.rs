//! What a composer holds before a turn is sent: the workspace locations the
//! turn carries, the files the person is attaching, and the model the turn
//! will run on. Plain data; the host and the conversation owner fill and read
//! them.

use serde::{Deserialize, Serialize};

use crate::results::Range;

/// A workspace file location a turn carries. The TypeScript owner maps it to
/// the SDK's `TheoremContextReference {location, excerpt?, label?}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SourceReference {
    /// The file, relative to the workspace root.
    pub path: String,
    /// The part of it, when the reference is not the whole file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub range: Option<Range>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub label: Option<String>,
    /// The text the person saw there, so the turn says what it was about even
    /// if the file changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub excerpt: Option<String>,
}

/// Where a file the person is attaching stands. The browser holds the file;
/// the owner uploads it when the turn is sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum DraftAttachmentState {
    /// Being read by the browser.
    Adding,
    /// Held and ready to send.
    Ready,
    /// Not accepted; `reason` says why.
    Refused,
}

/// One file in the draft of the next turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DraftAttachment {
    /// Names it in `conversationAttachRemove`.
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub content_type: Option<String>,
    /// Bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "number"))]
    pub size: Option<u64>,
    pub state: DraftAttachmentState,
    /// Why it was refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub reason: Option<String>,
}

/// A model a turn can run on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    /// The id `conversationSetModel` names it by.
    #[serde(rename = "ref")]
    #[cfg_attr(feature = "ts", ts(rename = "ref"))]
    pub model_ref: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "number"))]
    pub context_tokens: Option<u64>,
}
