//! Icons in the cell grid: a small vocabulary of marks, a helper that places
//! one at a cell, and the pass that collects them once a frame is drawn.
//!
//! Hand-rolled: nothing in Ratatui or Ratzilla models an image in a cell. A
//! panel calls [`put_icon`], which writes a sentinel into the buffer: the
//! mark's own two-character symbol in the first cell and a tail symbol in the
//! second, so an icon is two cells wide and one high. After the whole frame is
//! drawn, [`take_icons`] reads every sentinel still standing as
//! `(x, y, icon)` and blanks those cells. An icon whose cells were overdrawn
//! (by a popup, a menu or another panel), clipped or scrolled away is simply
//! not there to find, so none of that needs bookkeeping.
//!
//! A sentinel is a symbol of two private-use characters. A string written
//! through `Buffer::set_stringn` puts one grapheme in a cell, so text from a
//! file name, an editor or a terminal can never make one; only
//! `Cell::set_symbol` can. Both halves must be standing for an icon to count: a
//! popup that covers only the second cell drops the icon too.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use serde::{Deserialize, Serialize};

/// Cells an icon is wide.
pub const ICON_WIDTH: u16 = 2;

/// A mark of the workbench's icon set. The name each one serialises to is its
/// key in the page's `CONTROL_LAYERS` (the owner's Streamline marks, split
/// into themed layers by `scripts/rail-icons.mjs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Icon {
    /// A closed drop-down.
    FolderEmpty,
    /// An open drop-down.
    FolderFile,
    /// The workspace root.
    FolderHome,
    FolderCheck,
    FolderEdit,
    /// Plain text and Markdown.
    FileText,
    /// Source code.
    FileCode,
    /// A file with nothing more to say of it.
    FileEmpty,
    FileCheck,
    /// A modified file.
    FileEdit,
    /// An added file.
    FileAdd,
    /// An image.
    ImageFileEdit,
    /// A fork.
    FileModule,
    /// A continuation.
    FileDouble,
    FileDouble2,
}

impl Icon {
    /// Every icon, in the order that gives each its sentinel.
    pub const ALL: [Icon; 15] = [
        Icon::FolderEmpty,
        Icon::FolderFile,
        Icon::FolderHome,
        Icon::FolderCheck,
        Icon::FolderEdit,
        Icon::FileText,
        Icon::FileCode,
        Icon::FileEmpty,
        Icon::FileCheck,
        Icon::FileEdit,
        Icon::FileAdd,
        Icon::ImageFileEdit,
        Icon::FileModule,
        Icon::FileDouble,
        Icon::FileDouble2,
    ];

    /// The key the page knows it by (the serde name).
    pub fn name(self) -> String {
        serde_json::to_value(self)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default()
    }

    fn index(self) -> u32 {
        Self::ALL.iter().position(|i| *i == self).unwrap_or(0) as u32
    }

    /// The first cell's symbol.
    fn head(self) -> String {
        [
            MARK,
            char::from_u32(HEAD_BASE + self.index()).unwrap_or(MARK),
        ]
        .iter()
        .collect()
    }
}

/// The icon of a file by its name: images, text and Markdown, and source code
/// (programs, markup, styles, shell, SQL and the config formats edited as code)
/// each have their own; anything else is the plain file. A name with no
/// extension is judged whole (`Makefile`); a leading dot is not an extension.
pub fn file_icon(name: &str) -> Icon {
    let name = name.rsplit('/').next().unwrap_or(name).to_ascii_lowercase();
    let extension = match name.rfind('.') {
        Some(0) | None => "",
        Some(i) => &name[i + 1..],
    };
    match extension {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "avif" | "bmp" | "ico" | "heic"
        | "tif" | "tiff" => Icon::ImageFileEdit,
        "md" | "markdown" | "mdx" | "txt" | "text" | "rst" | "adoc" => Icon::FileText,
        "rs" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "go" | "java" | "kt"
        | "swift" | "c" | "h" | "cc" | "cpp" | "hpp" | "cs" | "rb" | "php" | "lua" | "sh"
        | "bash" | "zsh" | "fish" | "sql" | "css" | "scss" | "html" | "htm" | "vue" | "svelte"
        | "json" | "toml" | "yaml" | "yml" | "zig" | "ex" | "exs" | "dart" => Icon::FileCode,
        "" if matches!(name.as_str(), "makefile" | "dockerfile" | "justfile") => Icon::FileCode,
        _ => Icon::FileEmpty,
    }
}

/// Opens every sentinel: plane 16's private use area, which no font set and no
/// terminal program in common use draws from.
const MARK: char = '\u{10F000}';
const HEAD_BASE: u32 = 0x10F100;
const TAIL: &str = "\u{10F000}\u{10F0FF}";

/// An icon the frame carries at a cell: its first cell's column and its row.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct PlacedIcon {
    pub x: u16,
    pub y: u16,
    pub icon: Icon,
}

/// Places `icon` over the two cells at `x`, `y`, inside the column `limit`, in
/// `style`; returns the column after the icon and one blank cell, where a name
/// goes. An icon that does not fit whole is not placed (a row cut short shows a
/// gap, never half a mark).
pub fn put_icon(buf: &mut Buffer, x: u16, y: u16, limit: u16, icon: Icon, style: Style) -> u16 {
    let end = x.saturating_add(ICON_WIDTH);
    let next = limit.min(end.saturating_add(1));
    if end > limit || !buf.area.contains((x, y).into()) || !buf.area.contains((end - 1, y).into()) {
        return next;
    }
    buf[(x, y)].set_symbol(&icon.head()).set_style(style);
    buf[(x + 1, y)].set_symbol(TAIL).set_style(style);
    next
}

fn icon_of(symbol: &str) -> Option<Icon> {
    let mut chars = symbol.chars();
    let (first, second) = (chars.next()?, chars.next()?);
    if first != MARK || chars.next().is_some() {
        return None;
    }
    let index = (second as u32).checked_sub(HEAD_BASE)?;
    Icon::ALL.get(index as usize).copied()
}

/// The pass after a frame is drawn: every icon still whole in `buf` as where it
/// is and what it is, in reading order, with its cells blanked. No sentinel
/// survives it: a half left standing is blanked and dropped.
pub fn take_icons(buf: &mut Buffer) -> Vec<PlacedIcon> {
    let Rect {
        x,
        y,
        width,
        height,
    } = buf.area;
    let mut found = vec![];
    for row in y..y + height {
        for col in x..x + width {
            let symbol = buf[(col, row)].symbol();
            let Some(icon) = icon_of(symbol) else {
                if symbol == TAIL {
                    buf[(col, row)].set_symbol(" ");
                }
                continue;
            };
            let whole = col + 1 < x + width && buf[(col + 1, row)].symbol() == TAIL;
            buf[(col, row)].set_symbol(" ");
            if whole {
                buf[(col + 1, row)].set_symbol(" ");
                found.push(PlacedIcon {
                    x: col,
                    y: row,
                    icon,
                });
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::{Color, Modifier};
    use ratatui::widgets::{Clear, Widget};

    fn blank(width: u16) -> Buffer {
        Buffer::empty(Rect::new(0, 0, width, 3))
    }

    fn text(buf: &Buffer, y: u16) -> String {
        (0..buf.area.width)
            .map(|x| buf[(x, y)].symbol().to_owned())
            .collect()
    }

    #[test]
    fn an_icon_takes_two_cells_and_is_found_where_it_was_put() {
        let mut buf = blank(10);
        let next = put_icon(&mut buf, 2, 1, 10, Icon::FolderFile, Style::new());
        // The icon, then one blank cell, then the name.
        assert_eq!(next, 5);
        buf.set_string(5, 1, "src", Style::new());
        let icons = take_icons(&mut buf);
        assert_eq!(
            icons,
            vec![PlacedIcon {
                x: 2,
                y: 1,
                icon: Icon::FolderFile
            }]
        );
        assert_eq!(text(&buf, 1), "     src  ");
    }

    #[test]
    fn the_cells_keep_the_style_they_were_given() {
        let mut buf = blank(6);
        let style = Style::new().bg(Color::Red).add_modifier(Modifier::BOLD);
        put_icon(&mut buf, 0, 0, 6, Icon::FileCode, style);
        take_icons(&mut buf);
        assert_eq!(buf[(0, 0)].bg, Color::Red);
        assert_eq!(buf[(1, 0)].bg, Color::Red);
    }

    #[test]
    fn every_icon_comes_back_as_itself() {
        for icon in Icon::ALL {
            let mut buf = blank(4);
            put_icon(&mut buf, 1, 2, 4, icon, Style::new());
            assert_eq!(take_icons(&mut buf), vec![PlacedIcon { x: 1, y: 2, icon }]);
        }
    }

    #[test]
    fn no_sentinel_survives_the_pass() {
        let mut buf = blank(12);
        for (i, icon) in Icon::ALL.iter().enumerate().take(5) {
            put_icon(&mut buf, (i as u16) * 2, 0, 12, *icon, Style::new());
        }
        // A half left alone, and a tail with no head.
        buf[(0, 2)].set_symbol(&Icon::FileText.head());
        buf[(5, 2)].set_symbol(TAIL);
        take_icons(&mut buf);
        for y in 0..3 {
            assert!(
                text(&buf, y).chars().all(|c| c == ' '),
                "row {y}: {:?}",
                text(&buf, y)
            );
        }
    }

    #[test]
    fn a_popup_drawn_over_a_row_drops_its_icon() {
        let mut buf = blank(12);
        put_icon(&mut buf, 0, 0, 12, Icon::FolderEmpty, Style::new());
        put_icon(&mut buf, 0, 1, 12, Icon::FileText, Style::new());
        put_icon(&mut buf, 0, 2, 12, Icon::FileCode, Style::new());
        // Covers the whole of row 0, only the second cell of row 1, and none of row 2.
        Clear.render(Rect::new(0, 0, 12, 1), &mut buf);
        buf.set_string(1, 1, "x", Style::new());
        let icons = take_icons(&mut buf);
        assert_eq!(
            icons,
            vec![PlacedIcon {
                x: 0,
                y: 2,
                icon: Icon::FileCode
            }]
        );
        assert_eq!(text(&buf, 1), " x          ");
    }

    #[test]
    fn text_cannot_forge_an_icon() {
        let mut buf = blank(8);
        // What the head and tail would be, written as text: one grapheme per cell.
        buf.set_string(
            0,
            0,
            "\u{10F000}\u{10F100}\u{10F000}\u{10F0FF}",
            Style::new(),
        );
        assert!(take_icons(&mut buf).is_empty());
    }

    #[test]
    fn an_icon_that_does_not_fit_is_not_placed() {
        let mut buf = blank(6);
        assert_eq!(put_icon(&mut buf, 5, 0, 6, Icon::FileText, Style::new()), 6);
        assert_eq!(put_icon(&mut buf, 2, 0, 3, Icon::FileText, Style::new()), 3);
        assert_eq!(
            put_icon(&mut buf, 8, 0, 20, Icon::FileText, Style::new()),
            11
        );
        assert!(take_icons(&mut buf).is_empty());
    }

    #[test]
    fn a_file_is_known_by_its_extension() {
        for (name, icon) in [
            ("main.rs", Icon::FileCode),
            ("App.TSX", Icon::FileCode),
            ("a/b/lib.py", Icon::FileCode),
            ("Makefile", Icon::FileCode),
            ("logo.png", Icon::ImageFileEdit),
            ("photo.JPEG", Icon::ImageFileEdit),
            ("README.md", Icon::FileText),
            ("notes.txt", Icon::FileText),
            ("Cargo.lock", Icon::FileEmpty),
            ("archive.tar.gz", Icon::FileEmpty),
            (".gitignore", Icon::FileEmpty),
            ("LICENSE", Icon::FileEmpty),
            ("", Icon::FileEmpty),
            ("trailing.", Icon::FileEmpty),
        ] {
            assert_eq!(file_icon(name), icon, "{name}");
        }
    }

    #[test]
    fn names_are_the_page_keys() {
        assert_eq!(Icon::FolderEmpty.name(), "folderEmpty");
        assert_eq!(Icon::ImageFileEdit.name(), "imageFileEdit");
        assert_eq!(Icon::FileDouble2.name(), "fileDouble2");
        let all: Vec<String> = Icon::ALL.iter().map(|i| i.name()).collect();
        assert_eq!(all.len(), Icon::ALL.len());
    }
}
