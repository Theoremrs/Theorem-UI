//! The roles the three panels draw with, read from the workbench theme. This crate holds no
//! palette.
//!
//! Every role comes from the theme: a match is `search_match`, a finding's severity is
//! `diagnostic_*`, the ANSI colours of run output are remapped through `ansi`. The one
//! modifier held here is UNDERLINED on a match, because the plain theme tells roles apart by
//! modifier only and a `search_match` that is the warning role would otherwise look like a
//! warning.

use ratatui::style::{Color, Modifier, Style};
use theorem_workbench_core::Theme;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Styles {
    pub text: Style,
    pub muted: Style,
    pub bold: Style,
    /// The row the cursor is on while the panel has focus.
    pub cursor: Style,
    /// The row the cursor is on while it does not.
    pub cursor_idle: Style,
    /// A control that is on (a toggle, the chosen filter).
    pub on: Style,
    pub error: Style,
    pub warning: Style,
    pub finding_error: Style,
    pub finding_warning: Style,
    pub info: Style,
    pub hint: Style,
    pub success: Style,
    /// The matched characters of a search row.
    pub hit: Style,
    /// The theme's 16 terminal colours; `Color::Reset` where the host set none.
    pub ansi: [Color; 16],
}

impl Styles {
    pub(crate) fn from_theme(theme: &Theme) -> Self {
        Self {
            text: theme.text,
            muted: theme.muted,
            bold: theme.text.add_modifier(Modifier::BOLD),
            cursor: theme.focus,
            cursor_idle: theme.selected,
            on: theme.focus,
            error: theme.error,
            warning: theme.warning,
            finding_error: theme.diagnostic_error,
            finding_warning: theme.diagnostic_warning,
            info: theme.diagnostic_info,
            hint: theme.diagnostic_hint,
            success: theme.success,
            hit: theme.search_match.add_modifier(Modifier::UNDERLINED),
            ansi: theme.ansi,
        }
    }
}
