//! The colors and weights markdown is drawn with, as named roles.
//!
//! The caller supplies every style; nothing here chooses a palette.
//! [`MarkdownStyles::plain`] is the one constructor that fills the roles, and
//! it uses text modifiers only (bold, italic, underline, reverse), so a host
//! with a theme builds its own value and a test has something to draw with.

use ratatui::style::{Modifier, Style};
use tui_markdown::{AlertKind, StyleSheet};

/// Every role the four modes draw with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarkdownStyles {
    /// Text with no role of its own.
    pub text: Style,
    /// Headings, level 1 to 6.
    pub heading: [Style; 6],
    /// Inline code and code blocks.
    pub code: Style,
    /// Link labels.
    pub link: Style,
    /// Block quotes.
    pub quote: Style,
    /// Heading attributes after the heading text.
    pub heading_meta: Style,
    /// Front matter.
    pub front_matter: Style,
    /// Raw HTML.
    pub html: Style,
    /// Inline math.
    pub math_inline: Style,
    /// Display math.
    pub math_display: Style,
    /// Footnote references.
    pub footnote_ref: Style,
    /// Footnote definitions.
    pub footnote_def: Style,
    /// Alerts: note, tip, important, warning, caution.
    pub alert: [Style; 5],
    /// A table's header row.
    pub table_header: Style,
    /// A table's cells.
    pub table_cell: Style,
    /// A table's borders.
    pub table_border: Style,
    /// List bullets and numbers.
    pub list_marker: Style,
    /// Image descriptions.
    pub image_alt: Style,
    /// The selection.
    pub selection: Style,
    /// Text being composed.
    pub preedit: Style,
    /// Ranges the caret cannot enter.
    pub atomic: Style,
    /// Text the document owner refused.
    pub conflict: Style,
    /// Line numbers in Source.
    pub line_number: Style,
    /// The bar beside the block being typed in.
    pub editing: Style,
    /// The bar beside a block held for the user to resolve.
    pub held: Style,
    /// The column between Source and the document in Split.
    pub divider: Style,
}

impl MarkdownStyles {
    /// Every role, with modifiers and no color.
    pub fn plain() -> Self {
        let bold = Style::new().add_modifier(Modifier::BOLD);
        let italic = Style::new().add_modifier(Modifier::ITALIC);
        let dim = Style::new().add_modifier(Modifier::DIM);
        let underline = Style::new().add_modifier(Modifier::UNDERLINED);
        let reverse = Style::new().add_modifier(Modifier::REVERSED);
        Self {
            text: Style::new(),
            heading: [
                bold.add_modifier(Modifier::UNDERLINED),
                bold,
                bold.add_modifier(Modifier::ITALIC),
                italic,
                italic,
                italic,
            ],
            code: dim,
            link: underline,
            quote: italic,
            heading_meta: dim,
            front_matter: dim,
            html: dim,
            math_inline: italic,
            math_display: italic,
            footnote_ref: underline,
            footnote_def: dim,
            alert: [bold; 5],
            table_header: bold,
            table_cell: Style::new(),
            table_border: dim,
            list_marker: bold,
            image_alt: italic,
            selection: reverse,
            preedit: underline,
            atomic: bold,
            conflict: underline.add_modifier(Modifier::ITALIC),
            line_number: dim,
            editing: reverse,
            held: reverse.add_modifier(Modifier::SLOW_BLINK),
            divider: dim,
        }
    }

    /// The roles the text session draws with.
    pub(crate) fn editor(&self) -> theorem_workbench_text::EditorStyles {
        theorem_workbench_text::EditorStyles {
            base: self.text,
            selection: self.selection,
            preedit: self.preedit,
            atomic: self.atomic,
            conflict: self.conflict,
            line_number: self.line_number,
        }
    }
}

impl StyleSheet for MarkdownStyles {
    fn heading(&self, level: u8) -> Style {
        self.heading[usize::from(level.clamp(1, 6)) - 1]
    }
    fn code(&self) -> Style {
        self.code
    }
    fn link(&self) -> Style {
        self.link
    }
    fn blockquote(&self) -> Style {
        self.quote
    }
    fn heading_meta(&self) -> Style {
        self.heading_meta
    }
    fn metadata_block(&self) -> Style {
        self.front_matter
    }
    fn html(&self) -> Style {
        self.html
    }
    fn math_inline(&self) -> Style {
        self.math_inline
    }
    fn math_display(&self) -> Style {
        self.math_display
    }
    fn footnote_ref(&self) -> Style {
        self.footnote_ref
    }
    fn footnote_def(&self) -> Style {
        self.footnote_def
    }
    fn alert(&self, kind: AlertKind) -> Style {
        self.alert[match kind {
            AlertKind::Note => 0,
            AlertKind::Tip => 1,
            AlertKind::Important => 2,
            AlertKind::Warning => 3,
            AlertKind::Caution => 4,
        }]
    }
    fn table_header(&self) -> Style {
        self.table_header
    }
    fn table_cell(&self) -> Style {
        self.table_cell
    }
    fn table_border(&self) -> Style {
        self.table_border
    }
    fn list_marker(&self) -> Style {
        self.list_marker
    }
    fn image_alt(&self) -> Style {
        self.image_alt
    }
}
