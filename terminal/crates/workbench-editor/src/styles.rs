//! The roles the editing widget is drawn with.
//!
//! The widget takes its roles as this value. [`EditorStyles::from_theme`]
//! reads them from the core `Theme`'s editing, finding and syntax roles, so
//! the mount themes every panel from one palette.

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
    /// Text an input method is composing, patched over `text`.
    pub preedit: Style,
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
    /// A hover, a completion list or a list of places, behind its text.
    pub popup: Style,
    /// The row of such a list the Enter key takes.
    pub popup_selected: Style,
    /// The language owner's findings, by severity: drawn under the text they
    /// cover and as the mark in the line-number column.
    pub error: Style,
    pub warning: Style,
    pub info: Style,
    pub hint: Style,
    /// Syntax colour, by the class the host's tokenizer names: keywords,
    /// strings, numbers, comments, functions, and types and tags.
    pub keyword: Style,
    pub string: Style,
    pub number: Style,
    pub comment: Style,
    pub function: Style,
    pub name: Style,
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
            preedit: Style::default().add_modifier(Modifier::UNDERLINED),
            search_match: Style::default().add_modifier(Modifier::UNDERLINED),
            current_match: Style::default().add_modifier(Modifier::UNDERLINED | Modifier::BOLD),
            conflict: Style::default().add_modifier(Modifier::ITALIC | Modifier::UNDERLINED),
            atomic: Style::default().add_modifier(Modifier::BOLD),
            caret: Style::default().add_modifier(Modifier::REVERSED | Modifier::BOLD),
            popup: Style::default().add_modifier(Modifier::REVERSED),
            popup_selected: Style::default().add_modifier(Modifier::REVERSED | Modifier::BOLD),
            error: Style::default().add_modifier(Modifier::UNDERLINED | Modifier::BOLD),
            warning: Style::default().add_modifier(Modifier::UNDERLINED),
            info: Style::default().add_modifier(Modifier::DIM | Modifier::UNDERLINED),
            hint: Style::default().add_modifier(Modifier::DIM),
            keyword: Style::default().add_modifier(Modifier::BOLD),
            string: Style::default().add_modifier(Modifier::ITALIC),
            number: Style::default(),
            comment: Style::default().add_modifier(Modifier::DIM | Modifier::ITALIC),
            function: Style::default().add_modifier(Modifier::BOLD | Modifier::ITALIC),
            name: Style::default(),
        }
    }

    /// Each role straight from the theme's editing, finding and syntax roles,
    /// so the mount themes every panel from one palette.
    pub fn from_theme(theme: &Theme) -> Self {
        Self {
            text: theme.text,
            gutter: theme.gutter,
            gutter_current: theme.gutter_current,
            current_line: theme.current_line,
            selection: theme.selection,
            preedit: theme.preedit,
            search_match: theme.search_match,
            current_match: theme.current_match,
            conflict: theme.conflict,
            atomic: theme.atomic,
            caret: theme.caret,
            popup: theme.popup,
            popup_selected: theme.popup_selected,
            error: theme.diagnostic_error,
            warning: theme.diagnostic_warning,
            info: theme.diagnostic_info,
            hint: theme.diagnostic_hint,
            keyword: theme.syntax_keyword,
            string: theme.syntax_string,
            number: theme.syntax_number,
            comment: theme.syntax_comment,
            function: theme.syntax_function,
            name: theme.syntax_name,
        }
    }
}

impl EditorStyles {
    /// The style of a highlight class, in the classes the TypeScript
    /// tokenizer emits. A class with no role of its own is plain text.
    pub fn class(&self, class: &str) -> Style {
        match class {
            "keyword" | "deleted" => self.keyword,
            "function" | "command" | "operator" => self.function,
            "number" | "literal" | "attr" | "property" => self.number,
            "string" | "inserted" => self.string,
            "type" | "variable" | "code-inline" | "tag" | "selector" => self.name,
            "comment" | "meta" => self.comment,
            "heading" => self.keyword,
            _ => Style::default(),
        }
    }
}

impl Default for EditorStyles {
    fn default() -> Self {
        Self::plain()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::Color;

    /// The derivation from before the theme carried editor roles.
    fn old(theme: &Theme) -> EditorStyles {
        fn foreground(role: Style) -> Style {
            role.fg
                .map_or_else(Style::default, |c| Style::default().fg(c))
        }
        EditorStyles {
            text: theme.text,
            gutter: theme.muted,
            gutter_current: theme.text,
            current_line: Style::default(),
            selection: theme.selected,
            preedit: Style::default().add_modifier(Modifier::UNDERLINED),
            search_match: theme.warning,
            current_match: theme.focus,
            conflict: theme.error,
            atomic: theme.muted,
            caret: theme.focus,
            popup: theme.line,
            popup_selected: theme.selected,
            error: theme.error.add_modifier(Modifier::UNDERLINED),
            warning: theme.warning.add_modifier(Modifier::UNDERLINED),
            info: theme.text.add_modifier(Modifier::UNDERLINED),
            hint: theme.muted,
            keyword: foreground(theme.focus).add_modifier(Modifier::BOLD),
            string: foreground(theme.success),
            number: foreground(theme.warning),
            comment: theme.muted.add_modifier(Modifier::ITALIC),
            function: foreground(theme.text).add_modifier(Modifier::BOLD),
            name: foreground(theme.text),
        }
    }

    #[test]
    fn the_roles_read_from_the_theme_equal_the_old_derivation() {
        let rgb = |r, g, b| Style::default().fg(Color::Rgb(r, g, b));
        let chrome = Theme::chrome(
            Style::default().bg(Color::Rgb(9, 9, 9)),
            rgb(200, 200, 200),
            rgb(100, 100, 100).add_modifier(Modifier::DIM),
            rgb(50, 50, 50),
            rgb(10, 120, 240).add_modifier(Modifier::BOLD),
            Style::default().bg(Color::Rgb(30, 30, 60)),
        );
        for theme in [Theme::plain(), chrome] {
            assert_eq!(EditorStyles::from_theme(&theme), old(&theme));
        }
    }
}
