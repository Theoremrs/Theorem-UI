//! The styles come from the theme's roles, and a theme with the default roles draws what
//! the panel drew before those roles existed.

use ratatui::style::{Color, Style};
use theorem_workbench_changes::ChangesStyles;
use theorem_workbench_core::Theme;

/// What the styles were derived as before the theme had change roles of its own.
fn before_the_roles(theme: &Theme) -> ChangesStyles {
    ChangesStyles {
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

fn fg(color: Color) -> Style {
    Style::default().fg(color)
}

#[test]
fn the_plain_theme_gives_the_styles_the_panel_had_before_the_roles() {
    let theme = Theme::plain();
    assert_eq!(ChangesStyles::from_theme(&theme), before_the_roles(&theme));
}

#[test]
fn a_chrome_theme_gives_the_styles_the_panel_had_before_the_roles() {
    let theme = Theme::chrome(
        fg(Color::Black),
        fg(Color::White),
        fg(Color::Gray),
        fg(Color::DarkGray),
        fg(Color::Blue),
        fg(Color::Cyan),
    );
    assert_eq!(ChangesStyles::from_theme(&theme), before_the_roles(&theme));
}

#[test]
fn a_chrome_theme_with_state_colors_gives_the_same_styles_as_before_the_roles() {
    let theme = Theme::chrome(
        fg(Color::Black),
        fg(Color::White),
        fg(Color::Gray),
        fg(Color::DarkGray),
        fg(Color::Blue),
        fg(Color::Cyan),
    )
    .with_state(fg(Color::Red), fg(Color::Yellow), fg(Color::Green));
    assert_eq!(ChangesStyles::from_theme(&theme), before_the_roles(&theme));
}

#[test]
fn each_changes_role_of_the_theme_reaches_its_own_style() {
    let mut theme = Theme::plain();
    theme.change_added = fg(Color::Green);
    theme.change_changed = fg(Color::Yellow);
    theme.change_deleted = fg(Color::Red);
    theme.change_conflict = fg(Color::Magenta);
    theme.change_untracked = fg(Color::Cyan);
    theme.section_heading = fg(Color::Blue);
    theme.hunk_header = fg(Color::LightBlue);
    theme.hunk_current = fg(Color::LightGreen);
    theme.control = fg(Color::LightRed);
    theme.control_disabled = fg(Color::DarkGray);
    theme.field_focus = fg(Color::LightYellow);
    let s = ChangesStyles::from_theme(&theme);
    assert_eq!(s.letter_added, fg(Color::Green));
    assert_eq!(s.letter_changed, fg(Color::Yellow));
    assert_eq!(s.letter_deleted, fg(Color::Red));
    assert_eq!(s.letter_conflict, fg(Color::Magenta));
    assert_eq!(s.letter_untracked, fg(Color::Cyan));
    assert_eq!(s.heading, fg(Color::Blue));
    assert_eq!(s.hunk_header, fg(Color::LightBlue));
    assert_eq!(s.hunk_current, fg(Color::LightGreen));
    assert_eq!(s.button, fg(Color::LightRed));
    assert_eq!(s.button_disabled, fg(Color::DarkGray));
    assert_eq!(s.field_focus, fg(Color::LightYellow));
}
