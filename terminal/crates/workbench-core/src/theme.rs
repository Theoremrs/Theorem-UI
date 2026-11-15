//! Named style roles for the workbench chrome. The names are the registry's
//! `theme_roles`; the values come from the host's theme, so this crate holds no
//! palette.
//!
//! The state and diff roles mirror the terminal palette's own names
//! (`terminal/src/lib.rs` `Palette`, resolved by `terminal-roles.ts`):
//! `state.error`, `state.warning`, `state.success` and `diff.addedLine`,
//! `diff.removedLine`, `diff.addedWords`, `diff.removedWords`. The mount fills
//! each from the palette field of the same name. The palette has no "changed"
//! role, so none is invented here.
//!
//! A `Theme` grows by adding roles. A host that builds one should start from
//! [`Theme::chrome`] (the six chrome roles; every other role is [`Theme::plain`]'s)
//! or from `..Theme::default()`, so a new role never breaks it.

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
    /// `state.error`: a failed operation, a refused edit.
    pub error: Style,
    /// `state.warning`: attention without failure (the warning family only).
    pub warning: Style,
    /// `state.success`
    pub success: Style,
    /// `diff.addedLine`: a line a change adds.
    pub added_line: Style,
    /// `diff.removedLine`: a line a change removes.
    pub removed_line: Style,
    /// `diff.addedWords`: the words that differ inside an added line.
    pub added_words: Style,
    /// `diff.removedWords`: the words that differ inside a removed line.
    pub removed_words: Style,
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
            error: Style::default().add_modifier(Modifier::BOLD | Modifier::ITALIC),
            warning: Style::default().add_modifier(Modifier::ITALIC),
            success: Style::default().add_modifier(Modifier::BOLD),
            added_line: Style::default().add_modifier(Modifier::ITALIC | Modifier::UNDERLINED),
            removed_line: Style::default().add_modifier(Modifier::CROSSED_OUT),
            added_words: Style::default().add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
            removed_words: Style::default().add_modifier(Modifier::BOLD | Modifier::CROSSED_OUT),
        }
    }

    /// The six chrome roles from the host; every other role is [`plain`](Self::plain)'s
    /// until the host sets it. This is what a host builds a theme from, so a
    /// role added later does not break it.
    pub fn chrome(
        bg: Style,
        text: Style,
        muted: Style,
        line: Style,
        focus: Style,
        selected: Style,
    ) -> Self {
        Self {
            bg,
            text,
            muted,
            line,
            focus,
            selected,
            ..Self::plain()
        }
    }

    /// Set `state.error`, `state.warning` and `state.success`.
    pub fn with_state(mut self, error: Style, warning: Style, success: Style) -> Self {
        self.error = error;
        self.warning = warning;
        self.success = success;
        self
    }

    /// Set the four diff roles.
    pub fn with_diff(
        mut self,
        added_line: Style,
        removed_line: Style,
        added_words: Style,
        removed_words: Style,
    ) -> Self {
        self.added_line = added_line;
        self.removed_line = removed_line;
        self.added_words = added_words;
        self.removed_words = removed_words;
        self
    }
}

impl Default for Theme {
    /// [`Theme::plain`].
    fn default() -> Self {
        Self::plain()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::Color;

    #[test]
    fn plain_tells_every_state_and_diff_role_apart_by_modifier() {
        let t = Theme::plain();
        let roles = [
            t.text,
            t.error,
            t.warning,
            t.success,
            t.added_line,
            t.removed_line,
            t.added_words,
            t.removed_words,
        ];
        for (i, a) in roles.iter().enumerate() {
            for b in &roles[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }

    #[test]
    fn chrome_keeps_the_other_roles_plain_and_the_builders_set_them() {
        let red = Style::new().fg(Color::Red);
        let t = Theme::chrome(red, red, red, red, red, red);
        assert_eq!(t.bg, red);
        assert_eq!(t.error, Theme::plain().error);
        assert_eq!(t.added_words, Theme::plain().added_words);

        let green = Style::new().fg(Color::Green);
        let t = t
            .with_state(red, green, green)
            .with_diff(green, red, green, red);
        assert_eq!((t.error, t.warning), (red, green));
        assert_eq!((t.added_line, t.removed_words), (green, red));
        assert_eq!(Theme::default(), Theme::plain());
    }
}
