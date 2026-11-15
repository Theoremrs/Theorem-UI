//! What a saved layout keeps of the panel, and what restoring it does.
//!
//! Written for this crate; not translated. It keeps the selection, the files whose diff
//! is open, the scroll position, the commit draft, the amend box and the diff layout.
//! It keeps no diff and no file contents: an open diff is asked for again when the first
//! status arrives. A path that no longer has a row is dropped without a word.

use serde::{Deserialize, Serialize};

use crate::model::{Changes, DiffLayout, Focus};
use crate::status::RowKey;
use crate::text::Withheld;

/// The shape of the saved state; a reader that finds another number starts clean.
pub const VERSION: u32 = 1;

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ViewState {
    pub version: u32,
    pub cursor: Option<RowKey>,
    pub selected: Vec<RowKey>,
    pub expanded: Vec<RowKey>,
    pub scroll: usize,
    pub subject: String,
    pub body: String,
    pub amend: bool,
    pub layout: DiffLayout,
    pub focus: Focus,
}

// The draft message is the person's words: `Debug` counts it.
impl std::fmt::Debug for ViewState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ViewState")
            .field("version", &self.version)
            .field("cursor", &self.cursor)
            .field("scroll", &self.scroll)
            .field("subject", &Withheld(self.subject.len()))
            .field("body", &Withheld(self.body.len()))
            .field("amend", &self.amend)
            .field("layout", &self.layout)
            .field("focus", &self.focus)
            .finish_non_exhaustive()
    }
}

impl Changes {
    pub fn view_state(&self) -> ViewState {
        let mut expanded: Vec<RowKey> = self.diffs.keys().cloned().collect();
        // A restored view whose diffs are not asked for yet keeps them in the saved state.
        expanded.extend(self.restored_open.iter().cloned());
        expanded.sort();
        expanded.dedup();
        ViewState {
            version: VERSION,
            cursor: self.cursor.clone(),
            selected: self.selected.iter().cloned().collect(),
            expanded,
            scroll: self.scroll,
            subject: self.subject.clone(),
            body: self.body.clone(),
            amend: self.amend,
            layout: self.layout,
            focus: self.focus,
        }
    }

    /// Puts saved state back. Rows that are not in the list now are tolerated: the
    /// selection and the open diffs are cut to the rows there are, or held until the
    /// first status says which there are. A wrong version restores nothing.
    pub fn restore(&mut self, state: &ViewState) {
        if state.version != VERSION {
            return;
        }
        self.subject = state.subject.clone();
        self.body = state.body.clone();
        self.layout = state.layout;
        self.focus = state.focus;
        self.amend = state.amend && self.amend_available();
        self.scroll = state.scroll;
        self.cursor = state.cursor.clone();
        self.anchor = state.cursor.clone();
        self.selected = state.selected.iter().cloned().collect();
        self.restored_open = state.expanded.iter().cloned().collect();
        if self.groups().is_some() {
            self.prune_restored();
        }
    }

    /// Drops the restored rows the list does not have.
    fn prune_restored(&mut self) {
        let keys = self.keys();
        self.selected.retain(|k| keys.contains(k));
        if let Some(cursor) = &self.cursor
            && !keys.contains(cursor)
        {
            self.cursor = keys.first().cloned();
            self.anchor = self.cursor.clone();
        }
        self.restored_open.retain(|k| keys.contains(k));
    }
}
