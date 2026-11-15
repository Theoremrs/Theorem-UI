//! The roles the panel draws with: the Markdown model's roles for rendered
//! blocks and the editor widget's roles for source.

use theorem_workbench_core::Theme;
use theorem_workbench_editor::EditorStyles;
use theorem_workbench_markdown::MarkdownStyles;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarkdownPanelStyles {
    /// Rendered blocks, the open block and the divider.
    pub markdown: MarkdownStyles,
    /// Source mode and the source pane of Split.
    pub editor: EditorStyles,
}

impl MarkdownPanelStyles {
    /// Modifiers only, so a test (or a host with no theme) tells every role apart.
    pub fn plain() -> Self {
        Self {
            markdown: MarkdownStyles::plain(),
            editor: EditorStyles::plain(),
        }
    }

    /// Every role from the core theme's role of the same meaning. The one
    /// exception is `atomic`: the theme's follows the editor (muted), and this
    /// panel keeps ranges the caret cannot enter bold.
    pub fn from_theme(theme: &Theme) -> Self {
        let markdown = MarkdownStyles {
            text: theme.text,
            heading: theme.heading,
            code: theme.code,
            link: theme.link,
            quote: theme.quote,
            heading_meta: theme.heading_meta,
            front_matter: theme.front_matter,
            html: theme.html,
            math_inline: theme.math,
            math_display: theme.math,
            footnote_ref: theme.footnote_ref,
            footnote_def: theme.footnote_def,
            alert: theme.alert,
            table_header: theme.table_header,
            table_cell: theme.table_cell,
            table_border: theme.table_border,
            list_marker: theme.list_marker,
            image_alt: theme.image_alt,
            selection: theme.selection,
            preedit: theme.preedit,
            atomic: MarkdownStyles::plain().atomic,
            conflict: theme.conflict,
            line_number: theme.gutter,
            editing: theme.editing_bar,
            held: theme.held_bar,
            divider: theme.divider,
        };
        Self {
            markdown,
            editor: EditorStyles::from_theme(theme),
        }
    }
}

impl Default for MarkdownPanelStyles {
    fn default() -> Self {
        Self::plain()
    }
}
