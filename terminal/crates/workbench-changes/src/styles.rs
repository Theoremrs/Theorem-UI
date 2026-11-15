//! The roles the Changes panel draws with.
//!
//! Written for this crate; not translated. The caller supplies every style from the
//! workbench theme ([`ChangesStyles::from_theme`]); nothing here chooses a palette.
//! [`ChangesStyles::plain`] tells the roles apart by modifier only, for a test or a host
//! with no theme yet.

use ratatui::style::Style;
use theorem_workbench_core::Theme;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangesStyles {
    /// Text with no role of its own.
    pub text: Style,
    pub muted: Style,
    /// The divider between the two sides of a split diff.
    pub line: Style,
    /// The cursor row while the list holds focus.
    pub cursor: Style,
    /// The cursor row while another part holds focus.
    pub cursor_idle: Style,
    /// A selected row that is not the cursor row.
    pub selected: Style,
    /// A section heading and the branch line.
    pub heading: Style,
    /// A row's letter by what it says: added, changed, deleted, in conflict, new.
    pub letter_added: Style,
    pub letter_changed: Style,
    pub letter_deleted: Style,
    pub letter_conflict: Style,
    pub letter_untracked: Style,
    pub error: Style,
    pub warning: Style,
    pub success: Style,
    pub added_line: Style,
    pub removed_line: Style,
    pub added_words: Style,
    pub removed_words: Style,
    pub hunk_header: Style,
    /// The hunk hunk-navigation is on.
    pub hunk_current: Style,
    /// A line number beside a diff line.
    pub gutter: Style,
    /// The field of the commit box that holds focus.
    pub field_focus: Style,
    /// The commit button when it can be pressed, and when it cannot.
    pub button: Style,
    pub button_disabled: Style,
}

impl ChangesStyles {
    pub fn from_theme(theme: &Theme) -> Self {
        Self {
            text: theme.text,
            muted: theme.muted,
            line: theme.line,
            cursor: theme.focus,
            cursor_idle: theme.selected,
            selected: theme.selected,
            heading: theme.muted,
            letter_added: theme.success,
            letter_changed: theme.warning,
            letter_deleted: theme.error,
            letter_conflict: theme.error,
            letter_untracked: theme.muted,
            error: theme.error,
            warning: theme.warning,
            success: theme.success,
            added_line: theme.added_line,
            removed_line: theme.removed_line,
            added_words: theme.added_words,
            removed_words: theme.removed_words,
            hunk_header: theme.muted,
            hunk_current: theme.selected,
            gutter: theme.muted,
            field_focus: theme.focus,
            button: theme.focus,
            button_disabled: theme.muted,
        }
    }

    /// Modifiers only: bold, dim, italic, underline, reverse and strike.
    pub fn plain() -> Self {
        Self::from_theme(&Theme::plain())
    }
}

impl Default for ChangesStyles {
    fn default() -> Self {
        Self::plain()
    }
}
