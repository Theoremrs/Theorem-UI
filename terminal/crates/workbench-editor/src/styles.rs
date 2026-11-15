//! The roles the editing widget is drawn with.
//!
//! The core `Theme` has no role for a line-number gutter, the current line or
//! a search match, so the widget takes them as this value. [`EditorStyles::from_theme`]
//! fills each from the nearest core role, so a host that has not defined the
//! editor roles still gets a readable editor; a host that has builds its own.

use ratatui::style::{Modifier, Style};
use theorem_workbench_core::Theme;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditorStyles {
    /// Text with no role of its own.
    pub text: Style,
    /// Line numbers.
    pub gutter: Style,
    /// The line number of the caret's line.
    pub gutter_current: Style,
    /// The whole row of the caret's line, when nothing is selected. Role
    /// missing from the core theme; empty unless the host sets it.
    pub current_line: Style,
    pub selection: Style,
    /// Every search match.
    pub search_match: Style,
    /// The match the caret is on.
    pub current_match: Style,
    /// Text the owner refused and the panel holds.
    pub conflict: Style,
    /// Ranges the caret cannot enter.
    pub atomic: Style,
    /// The cell under the caret while the panel has focus.
    pub caret: Style,
}

impl EditorStyles {
    /// Modifiers only, so a test (or a host with no theme) tells every role apart.
    pub fn plain() -> Self {
        Self {
            text: Style::default(),
            gutter: Style::default().add_modifier(Modifier::DIM),
            gutter_current: Style::default().add_modifier(Modifier::BOLD),
            current_line: Style::default(),
            selection: Style::default().add_modifier(Modifier::REVERSED),
            search_match: Style::default().add_modifier(Modifier::UNDERLINED),
            current_match: Style::default().add_modifier(Modifier::UNDERLINED | Modifier::BOLD),
            conflict: Style::default().add_modifier(Modifier::ITALIC | Modifier::UNDERLINED),
            atomic: Style::default().add_modifier(Modifier::BOLD),
            caret: Style::default().add_modifier(Modifier::REVERSED | Modifier::BOLD),
        }
    }

    /// Each role from the core role that means the nearest thing: the gutter is
    /// muted, the selection is `selected`, a match is `warning`, the current
    /// match and the caret are `focus`, held text is `error`.
    pub fn from_theme(theme: &Theme) -> Self {
        Self {
            text: theme.text,
            gutter: theme.muted,
            gutter_current: theme.text,
            current_line: Style::default(),
            selection: theme.selected,
            search_match: theme.warning,
            current_match: theme.focus,
            conflict: theme.error,
            atomic: theme.muted,
            caret: theme.focus,
        }
    }
}

impl Default for EditorStyles {
    fn default() -> Self {
        Self::plain()
    }
}
