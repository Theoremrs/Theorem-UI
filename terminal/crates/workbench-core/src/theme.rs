//! Named style roles for the workbench chrome. The names are the registry's
//! `theme_roles`; the values come from the host's theme, so this crate holds no
//! palette.

use ratatui::style::{Modifier, Style};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Theme {
    /// `chrome.bg`
    pub bg: Style,
    /// `chrome.text`
    pub text: Style,
    /// `chrome.muted`
    pub muted: Style,
    /// `chrome.line`: gutters and tab dividers.
    pub line: Style,
    /// `chrome.focus`: the focused group's active tab, a splitter being dragged.
    pub focus: Style,
    /// The active tab of an unfocused group, the picker's selected row.
    pub selected: Style,
}

impl Theme {
    /// A theme with no colors, telling the roles apart by modifier only. For
    /// tests and for a host that has not supplied one yet.
    pub fn plain() -> Self {
        Self {
            bg: Style::default(),
            text: Style::default(),
            muted: Style::default().add_modifier(Modifier::DIM),
            line: Style::default(),
            focus: Style::default().add_modifier(Modifier::REVERSED | Modifier::BOLD),
            selected: Style::default().add_modifier(Modifier::UNDERLINED),
        }
    }
}

impl Default for Theme {
    fn default() -> Self {
        Self::plain()
    }
}
