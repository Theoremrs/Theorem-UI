use ratatui::style::{Color, Style};
use theorem_workbench_core::theme::Theme;
use theorem_workbench_vt::Palette;

/// The terminal colours the pane falls back on. The context theme wins
/// wherever it models a role and sets a colour for it; this palette covers
/// what the theme leaves at `Color::Reset` or empty, so a host that has not
/// set the theme's roles yet draws exactly what it drew before they existed.
#[derive(Clone, Debug, Default)]
pub struct ProcessStyles {
    pub palette: Palette,
}

impl ProcessStyles {
    pub fn new(palette: Palette) -> Self {
        Self { palette }
    }

    /// The palette for one draw: the theme's roles over this fallback. Read at
    /// draw time so a theme change reaches the next frame with no panel state.
    pub(crate) fn resolve(&self, theme: &Theme) -> Palette {
        let mut p = self.palette.clone();
        if let Some(c) = set(theme.text.fg) {
            p.fg = c;
        }
        if let Some(c) = set(theme.bg.bg) {
            p.bg = c;
        }
        for (slot, c) in p.ansi.iter_mut().zip(theme.ansi) {
            if c != Color::Reset {
                *slot = c;
            }
        }
        // A role with only a modifier (the plain theme's reverse video) says
        // nothing about colour, so the fallback overlay stays.
        let overlay = |role: Style, fallback: Style| {
            if set(role.fg).is_some() || set(role.bg).is_some() {
                role
            } else {
                fallback
            }
        };
        p.selection = overlay(theme.selection, p.selection);
        p.search_match = overlay(theme.search_match, p.search_match);
        p.search_current = overlay(theme.current_match, p.search_current);
        p
    }
}

fn set(c: Option<Color>) -> Option<Color> {
    c.filter(|c| *c != Color::Reset)
}
