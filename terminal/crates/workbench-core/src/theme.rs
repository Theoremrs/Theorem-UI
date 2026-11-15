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
//! Beyond the chrome, state and diff roles the theme names what the panels
//! draw: text editing (gutter, current line, caret, search matches, popups),
//! language findings, syntax classes, prose (headings, links, code, tables),
//! changes (a file's letter, hunks, controls) and the terminal's 16 colors.
//! They are named by meaning, not by panel, so the editor, the Markdown panel
//! and Changes read the same `selection` or `gutter`. Every one of them has a
//! default derived from the six chrome roles and the state roles, exactly the
//! style the panels used before the roles existed: [`Theme::chrome`] and
//! [`Theme::with_state`] derive them, and the `with_*` setters override a
//! group. Derived roles follow `chrome` and `with_state`, so call those first
//! and the setters after.
//!
//! A `Theme` grows by adding roles. A host that builds one should start from
//! [`Theme::chrome`] (the six chrome roles; every other role is [`Theme::plain`]'s)
//! or from `..Theme::default()`, so a new role never breaks it.

use ratatui::style::{Color, Modifier, Style};

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

    // --- text editing ---
    /// Line numbers.
    pub gutter: Style,
    /// The line number of the caret's line.
    pub gutter_current: Style,
    /// The whole row of the caret's line when nothing is selected.
    pub current_line: Style,
    /// Selected text.
    pub selection: Style,
    /// Text being composed by an input method.
    pub preedit: Style,
    /// Every search match (also a terminal's).
    pub search_match: Style,
    /// The match the caret or search is on.
    pub current_match: Style,
    /// The cell under the caret while its panel has focus.
    pub caret: Style,
    /// Text the owner refused and the panel holds for the person to resolve.
    pub conflict: Style,
    /// Ranges the caret cannot enter.
    pub atomic: Style,
    /// A hover, completion list or list of places, behind its text.
    pub popup: Style,
    /// The row of such a list the Enter key takes.
    pub popup_selected: Style,
    /// The bar beside the block being typed in.
    pub editing_bar: Style,
    /// The bar beside a block held for the person to resolve.
    pub held_bar: Style,
    /// A column between two views of one thing.
    pub divider: Style,

    // --- the language owner's findings, drawn under the text they cover ---
    pub diagnostic_error: Style,
    pub diagnostic_warning: Style,
    pub diagnostic_info: Style,
    pub diagnostic_hint: Style,

    // --- syntax, by the class a tokenizer names ---
    pub syntax_keyword: Style,
    pub syntax_string: Style,
    pub syntax_number: Style,
    pub syntax_comment: Style,
    pub syntax_function: Style,
    /// Types, tags and other names.
    pub syntax_name: Style,

    // --- prose ---
    /// Headings, level 1 to 6.
    pub heading: [Style; 6],
    /// Inline code and code blocks.
    pub code: Style,
    pub link: Style,
    pub quote: Style,
    /// Heading attributes after the heading text.
    pub heading_meta: Style,
    pub front_matter: Style,
    /// Raw HTML.
    pub html: Style,
    /// Inline and display math.
    pub math: Style,
    pub footnote_ref: Style,
    pub footnote_def: Style,
    /// Alerts: note, tip, important, warning, caution.
    pub alert: [Style; 5],
    pub table_header: Style,
    pub table_cell: Style,
    pub table_border: Style,
    pub list_marker: Style,
    pub image_alt: Style,

    // --- changes ---
    /// A changed file's letter by what it says.
    pub change_added: Style,
    pub change_changed: Style,
    pub change_deleted: Style,
    pub change_conflict: Style,
    pub change_untracked: Style,
    /// A section heading and the branch line.
    pub section_heading: Style,
    pub hunk_header: Style,
    /// The hunk hunk-navigation is on.
    pub hunk_current: Style,
    /// A button that can be pressed, and one that cannot.
    pub control: Style,
    pub control_disabled: Style,
    /// The field of a form that holds focus.
    pub field_focus: Style,

    // --- terminal ---
    /// The 16 ANSI colors a terminal pane remaps. `Color::Reset` until the
    /// host sets them.
    pub ansi: [Color; 16],
}

impl Theme {
    /// A theme with no colors, telling the roles apart by modifier only. For
    /// tests and for a host that has not supplied one yet.
    pub fn plain() -> Self {
        Self::base_plain().derived()
    }

    /// The chrome, state and diff roles of [`plain`](Self::plain), with every
    /// derived role left empty for `derived` to fill.
    fn base_plain() -> Self {
        let none = Style::default();
        Self {
            gutter: none,
            gutter_current: none,
            current_line: none,
            selection: none,
            preedit: none,
            search_match: none,
            current_match: none,
            caret: none,
            conflict: none,
            atomic: none,
            popup: none,
            popup_selected: none,
            editing_bar: none,
            held_bar: none,
            divider: none,
            diagnostic_error: none,
            diagnostic_warning: none,
            diagnostic_info: none,
            diagnostic_hint: none,
            syntax_keyword: none,
            syntax_string: none,
            syntax_number: none,
            syntax_comment: none,
            syntax_function: none,
            syntax_name: none,
            heading: [none; 6],
            code: none,
            link: none,
            quote: none,
            heading_meta: none,
            front_matter: none,
            html: none,
            math: none,
            footnote_ref: none,
            footnote_def: none,
            alert: [none; 5],
            table_header: none,
            table_cell: none,
            table_border: none,
            list_marker: none,
            image_alt: none,
            change_added: none,
            change_changed: none,
            change_deleted: none,
            change_conflict: none,
            change_untracked: none,
            section_heading: none,
            hunk_header: none,
            hunk_current: none,
            control: none,
            control_disabled: none,
            field_focus: none,
            ansi: [Color::Reset; 16],
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
        .derived()
    }

    /// Fill every derived role from the chrome and state roles as they stand:
    /// the style each panel used for it before the role existed.
    fn derived(mut self) -> Self {
        let fg = |role: Style| {
            role.fg
                .map_or_else(Style::default, |c| Style::default().fg(c))
        };
        let bold = Style::default().add_modifier(Modifier::BOLD);
        let italic = Style::default().add_modifier(Modifier::ITALIC);
        let dim = Style::default().add_modifier(Modifier::DIM);
        let underline = Style::default().add_modifier(Modifier::UNDERLINED);

        self.gutter = self.muted;
        self.gutter_current = self.text;
        self.current_line = Style::default();
        self.selection = self.selected;
        self.preedit = underline;
        self.search_match = self.warning;
        self.current_match = self.focus;
        self.caret = self.focus;
        self.conflict = self.error;
        self.atomic = self.muted;
        self.popup = self.line;
        self.popup_selected = self.selected;
        self.editing_bar = self.focus;
        self.held_bar = self.error;
        self.divider = self.line;

        self.diagnostic_error = self.error.add_modifier(Modifier::UNDERLINED);
        self.diagnostic_warning = self.warning.add_modifier(Modifier::UNDERLINED);
        self.diagnostic_info = self.text.add_modifier(Modifier::UNDERLINED);
        self.diagnostic_hint = self.muted;

        self.syntax_keyword = fg(self.focus).add_modifier(Modifier::BOLD);
        self.syntax_string = fg(self.success);
        self.syntax_number = fg(self.warning);
        self.syntax_comment = self.muted.add_modifier(Modifier::ITALIC);
        self.syntax_function = fg(self.text).add_modifier(Modifier::BOLD);
        self.syntax_name = fg(self.text);

        self.heading = [
            bold.add_modifier(Modifier::UNDERLINED),
            bold,
            bold.add_modifier(Modifier::ITALIC),
            italic,
            italic,
            italic,
        ];
        self.code = self.muted;
        self.link = underline;
        self.quote = self.muted;
        self.heading_meta = dim;
        self.front_matter = dim;
        self.html = dim;
        self.math = italic;
        self.footnote_ref = underline;
        self.footnote_def = dim;
        self.alert = [bold; 5];
        self.table_header = bold;
        self.table_cell = Style::default();
        self.table_border = self.muted;
        self.list_marker = bold;
        self.image_alt = italic;

        self.change_added = self.success;
        self.change_changed = self.warning;
        self.change_deleted = self.error;
        self.change_conflict = self.error;
        self.change_untracked = self.muted;
        self.section_heading = self.muted;
        self.hunk_header = self.muted;
        self.hunk_current = self.selected;
        self.control = self.focus;
        self.control_disabled = self.muted;
        self.field_focus = self.focus;
        self
    }

    /// Set `state.error`, `state.warning` and `state.success`.
    pub fn with_state(mut self, error: Style, warning: Style, success: Style) -> Self {
        self.error = error;
        self.warning = warning;
        self.success = success;
        self.derived_state()
    }

    /// Re-derive the roles that follow the state roles, leaving the others as
    /// they are set.
    fn derived_state(mut self) -> Self {
        let derived = self.clone().derived();
        self.search_match = derived.search_match;
        self.conflict = derived.conflict;
        self.held_bar = derived.held_bar;
        self.diagnostic_error = derived.diagnostic_error;
        self.diagnostic_warning = derived.diagnostic_warning;
        self.syntax_string = derived.syntax_string;
        self.syntax_number = derived.syntax_number;
        self.change_added = derived.change_added;
        self.change_changed = derived.change_changed;
        self.change_deleted = derived.change_deleted;
        self.change_conflict = derived.change_conflict;
        self
    }

    /// Set the text-editing roles: gutter, current gutter line, current line,
    /// caret and the popup pair.
    pub fn with_editing(
        mut self,
        gutter: Style,
        gutter_current: Style,
        current_line: Style,
        caret: Style,
        popup: Style,
        popup_selected: Style,
    ) -> Self {
        self.gutter = gutter;
        self.gutter_current = gutter_current;
        self.current_line = current_line;
        self.caret = caret;
        self.popup = popup;
        self.popup_selected = popup_selected;
        self
    }

    /// Set the surface a popup's rows are drawn on (a menu, a completion list) and its chosen
    /// row. Each carries a foreground and a background, so a row reads over whatever the popup
    /// covers and the chosen one is told from the rest.
    pub fn with_popup(mut self, popup: Style, popup_selected: Style) -> Self {
        self.popup = popup;
        self.popup_selected = popup_selected;
        self
    }

    /// Set the search roles: every match, and the current one.
    pub fn with_search(mut self, search_match: Style, current_match: Style) -> Self {
        self.search_match = search_match;
        self.current_match = current_match;
        self
    }

    /// Set the roles for refused text and for ranges the caret cannot enter.
    pub fn with_held(mut self, conflict: Style, atomic: Style) -> Self {
        self.conflict = conflict;
        self.atomic = atomic;
        self
    }

    /// Set the language findings: error, warning, info, hint.
    pub fn with_diagnostics(
        mut self,
        error: Style,
        warning: Style,
        info: Style,
        hint: Style,
    ) -> Self {
        self.diagnostic_error = error;
        self.diagnostic_warning = warning;
        self.diagnostic_info = info;
        self.diagnostic_hint = hint;
        self
    }

    /// Set the syntax classes: keyword, string, number, comment, function, name.
    pub fn with_syntax(
        mut self,
        keyword: Style,
        string: Style,
        number: Style,
        comment: Style,
        function: Style,
        name: Style,
    ) -> Self {
        self.syntax_keyword = keyword;
        self.syntax_string = string;
        self.syntax_number = number;
        self.syntax_comment = comment;
        self.syntax_function = function;
        self.syntax_name = name;
        self
    }

    /// Set the terminal's 16 ANSI colors.
    pub fn with_ansi(mut self, ansi: [Color; 16]) -> Self {
        self.ansi = ansi;
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

    #[test]
    fn the_new_roles_default_to_what_the_panels_drew_before_they_existed() {
        let red = Style::new().fg(Color::Red);
        let green = Style::new().fg(Color::Green);
        let grey = Style::new().fg(Color::DarkGray);
        let blue = Style::new().fg(Color::Blue).bg(Color::Black);
        let t = Theme::chrome(red, green, grey, grey, blue, red).with_state(red, green, blue);
        assert_eq!(t.gutter, grey);
        assert_eq!(t.gutter_current, green);
        assert_eq!(t.selection, red);
        assert_eq!((t.search_match, t.current_match), (green, blue));
        assert_eq!(t.conflict, red);
        assert_eq!(t.diagnostic_error, red.add_modifier(Modifier::UNDERLINED));
        // A syntax role keeps the colour and drops the background.
        assert_eq!(
            t.syntax_keyword,
            Style::new().fg(Color::Blue).add_modifier(Modifier::BOLD)
        );
        assert_eq!(t.syntax_string, Style::new().fg(Color::Blue));
        assert_eq!(t.change_added, blue);
        assert_eq!(t.control, blue);
        assert_eq!(t.ansi, [Color::Reset; 16]);
    }

    #[test]
    fn state_follows_with_state_and_an_explicit_setter_after_it_wins() {
        let red = Style::new().fg(Color::Red);
        let cyan = Style::new().fg(Color::Cyan);
        let t = Theme::plain().with_state(red, red, red);
        assert_eq!(t.search_match, red);
        assert_eq!(t.change_deleted, red);
        let t = t.with_search(cyan, cyan);
        assert_eq!((t.search_match, t.current_match), (cyan, cyan));
        let t = t.with_syntax(cyan, cyan, cyan, cyan, cyan, cyan);
        assert_eq!(t.syntax_name, cyan);
        // The default is the plain theme's own.
        assert_eq!(Theme::default().gutter, Theme::plain().muted);
    }
}
