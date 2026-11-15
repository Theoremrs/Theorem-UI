use theorem_workbench_vt::Palette;

/// What the pane needs that the core's chrome `Theme` does not carry: the 16
/// ANSI colors, the default foreground and background, and the selection and
/// search overlays. The core theme has no source for them, so the mount builds
/// this from the terminal palette (the same roles the transcript drawer uses).
#[derive(Clone, Debug, Default)]
pub struct ProcessStyles {
    pub palette: Palette,
}

impl ProcessStyles {
    pub fn new(palette: Palette) -> Self {
        Self { palette }
    }
}
