//! The threads of a person's projects, as the Threads panel lists them.
//!
//! The owner reads them from the account (projects, threads, the open one) and
//! sends the whole listing, on request and whenever it changes. Every word in
//! it that a person typed or a program said (a title, a project name, a
//! delegation's label) is untrusted: the panel draws it spelled out and
//! publishes it escaped.
//!
//! Which of the optional fields a host fills is its own business, and what it
//! does not fill stays at its default: a host that cannot pin sends no pins,
//! and the panel offers no Pin where the host did not grant `threads.pin`.

use serde::{Deserialize, Serialize};

/// A colour a thread can be tagged with: one of the theme's own, named by its
/// ANSI slot, never a value of its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ThreadTag {
    Red,
    Yellow,
    Green,
    Cyan,
    Blue,
    Magenta,
}

impl ThreadTag {
    pub const ALL: [ThreadTag; 6] = [
        Self::Red,
        Self::Yellow,
        Self::Green,
        Self::Cyan,
        Self::Blue,
        Self::Magenta,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Red => "red",
            Self::Yellow => "yellow",
            Self::Green => "green",
            Self::Cyan => "cyan",
            Self::Blue => "blue",
            Self::Magenta => "magenta",
        }
    }
}

/// A project: the folder a thread is listed under.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadProject {
    pub id: String,
    pub name: String,
}

/// What a delegation of a thread's latest run is, in the words the run gave it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadDelegation {
    pub id: String,
    pub label: String,
    /// The run that holds it, for the row that opens its changes.
    pub run_id: String,
}

/// One thread.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadItem {
    pub id: String,
    pub title: String,
    /// Every project the thread is placed in. The first is where it opens.
    pub project_ids: Vec<String>,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub tag: Option<ThreadTag>,
    #[serde(default)]
    pub unread: bool,
    /// A run is working in it now.
    #[serde(default)]
    pub running: bool,
    /// Why it waits on the person (an approval, a question), in the account's
    /// own word. Absent when it does not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub needs_you: Option<String>,
    /// Milliseconds since the epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "number"))]
    pub created_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "number"))]
    pub last_message_ms: Option<i64>,
    /// The owner's revision of the thread, as it names it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub revision: Option<String>,
    /// The thread this one began from (a fork), when the account says so.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub origin: Option<String>,
    /// The delegations of its latest run.
    #[serde(default)]
    pub delegations: Vec<ThreadDelegation>,
}

/// The thread that is open, and the project it was opened under.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct OpenThread {
    pub project_id: String,
    pub thread_id: String,
}

/// The whole listing, replacing the last.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadListing {
    pub projects: Vec<ThreadProject>,
    pub threads: Vec<ThreadItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub open: Option<OpenThread>,
    /// The owner's clock when it read the list, in milliseconds since the
    /// epoch: what a relative time is counted from. The panel has no clock.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub as_of_ms: i64,
}

/// A thread that now exists.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadCreated {
    pub project_id: String,
    pub thread_id: String,
}

/// A thread as Markdown.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadMarkdown {
    pub text: String,
}

/// The thread an effect is about.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadRef {
    pub thread_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadsCreate {
    pub project_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadsRename {
    pub thread_id: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadsArchive {
    pub thread_id: String,
    pub archived: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadsPin {
    pub thread_id: String,
    pub pinned: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadsTag {
    pub thread_id: String,
    /// Absent clears the tag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub tag: Option<ThreadTag>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadsUnread {
    pub thread_id: String,
    pub unread: bool,
}

/// A short relative time, as a row shows it: `now`, `5m`, `3h`, `2d`, `6w`,
/// `1y`. Counted from the owner's clock, so a drawing is a function of the
/// listing alone.
pub fn relative(now_ms: i64, then_ms: i64) -> String {
    let secs = (now_ms - then_ms).max(0) / 1000;
    match secs {
        0..=44 => "now".to_owned(),
        45..=3_599 => format!("{}m", (secs / 60).max(1)),
        3_600..=86_399 => format!("{}h", secs / 3_600),
        86_400..=604_799 => format!("{}d", secs / 86_400),
        604_800..=31_535_999 => format!("{}w", secs / 604_800),
        _ => format!("{}y", secs / 31_536_000),
    }
}

#[cfg(test)]
mod tests {
    use super::relative;

    #[test]
    fn relative_times_are_short_and_counted_from_the_owners_clock() {
        let now = 10_000_000_000;
        assert_eq!(relative(now, now), "now");
        assert_eq!(relative(now, now - 5 * 60_000), "5m");
        assert_eq!(relative(now, now - 3 * 3_600_000), "3h");
        assert_eq!(relative(now, now - 2 * 86_400_000), "2d");
        assert_eq!(relative(now, now - 14 * 86_400_000), "2w");
        assert_eq!(relative(now, now - 400 * 86_400_000), "1y");
        assert_eq!(relative(now, now + 5_000), "now");
    }
}
