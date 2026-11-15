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

    /// The roles the core theme has a nearest meaning for are taken from it;
    /// the rest (headings, links, tables) keep their modifiers, because the
    /// core theme has no role for them.
    pub fn from_theme(theme: &Theme) -> Self {
        let mut markdown = MarkdownStyles::plain();
        markdown.text = theme.text;
        markdown.selection = theme.selected;
        markdown.conflict = theme.error;
        markdown.line_number = theme.muted;
        markdown.editing = theme.focus;
        markdown.held = theme.error;
        markdown.divider = theme.line;
        markdown.code = theme.muted;
        markdown.quote = theme.muted;
        markdown.table_border = theme.muted;
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
