//! The delegation panel as lines of cells and as semantic nodes.
//!
//! Written for this crate; not translated. A [`Layout`] is the whole document at one
//! width: every line already escaped and wrapped, so a line is never wider than the pane
//! and nothing is cut at its edge. Drawing and the semantic tree both read the same
//! layout, so they cannot say different things.

use std::ops::Range;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use theorem_workbench_core::ActionId;
use theorem_workbench_core::ids::ResourceRef;
use theorem_workbench_core::semantics::{Node, NodeAction, Role};
use theorem_workbench_text::layout::line_rows;

use super::actions;
use super::model::{File, Read, Shown, Side, State, change_word, letter, shape, side_words};
use crate::diff::{DiffLine, Hunk, LineKind};
use crate::styles::ChangesStyles;
use crate::text::{paint, put, wrap};

/// The narrowest a diff line's text is left; narrower, the line numbers are dropped.
const MIN_TEXT: usize = 8;
/// Rows at the foot of the pane that say which keys do what, when there is room.
const HINT_FROM_HEIGHT: u16 = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tone {
    Text,
    Muted,
    Heading,
    Error,
    Warning,
    Added,
    Removed,
    Hunk,
    /// Line numbers, over the line's own fill.
    Gutter,
    /// A change's letter in the list.
    Letter(char),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Seg {
    pub text: String,
    pub tone: Tone,
    /// A changed word inside a changed line.
    pub marked: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Line {
    pub segs: Vec<Seg>,
    /// The row's own colour, painted across its whole width.
    pub fill: Tone,
    /// The list entry this row belongs to.
    pub entry: Option<usize>,
}

impl Line {
    fn plain(text: &str, tone: Tone) -> Self {
        Self {
            segs: vec![Seg {
                text: text.to_owned(),
                tone,
                marked: false,
            }],
            fill: Tone::Text,
            entry: None,
        }
    }

    pub(crate) fn text(&self) -> String {
        self.segs.iter().map(|s| s.text.as_str()).collect()
    }
}

/// The whole document at one width.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Layout {
    pub lines: Vec<Line>,
    /// The lines that say how things stand.
    pub status: Range<usize>,
    /// For each list entry, its lines.
    pub files: Vec<(usize, Range<usize>)>,
    /// The diff's lines.
    pub diff: Range<usize>,
    /// The key hints, drawn at the foot when there is room.
    pub hint: Vec<Line>,
}

fn rows(text: &str, width: usize, tone: Tone, into: &mut Vec<Line>) {
    for row in wrap(text, width) {
        into.push(Line::plain(&row, tone));
    }
}

fn status_tone<T>(read: &Read<T>) -> Tone {
    match read {
        Read::Refused { .. } | Read::Failed(_) => Tone::Error,
        Read::Uncertain(_) | Read::Revoked => Tone::Warning,
        _ => Tone::Muted,
    }
}

pub(crate) fn layout(state: &State, width: usize) -> Layout {
    let width = width.max(1);
    let mut out = Layout::default();
    match &state.file {
        None => list(state, width, &mut out),
        Some(file) => open_file(state, file, width, &mut out),
    }
    let hint = if state.file.is_some() {
        "Esc: back  r: reload"
    } else {
        "Enter: open  r: reload"
    };
    rows(hint, width, Tone::Muted, &mut out.hint);
    out
}

fn list(state: &State, width: usize, out: &mut Layout) {
    rows(
        &shape(&format!("Changes by delegation {}", state.delegation_id)),
        width,
        Tone::Heading,
        &mut out.lines,
    );
    if let Some(notice) = &state.notice {
        rows(notice, width, Tone::Warning, &mut out.lines);
    }
    let first = out.lines.len();
    rows(
        &state.list_words(),
        width,
        status_tone(&state.list),
        &mut out.lines,
    );
    out.status = first..out.lines.len();
    for (at, change) in state.changes().iter().enumerate() {
        let mark = letter(change.change);
        let mut text = shape(&change.path);
        if change.binary {
            text.push_str(" (binary)");
        }
        let start = out.lines.len();
        for (n, row) in wrap(&text, width.saturating_sub(2).max(1))
            .into_iter()
            .enumerate()
        {
            let lead = if n == 0 {
                Seg {
                    text: format!("{mark} "),
                    tone: Tone::Letter(mark),
                    marked: false,
                }
            } else {
                Seg {
                    text: "  ".to_owned(),
                    tone: Tone::Text,
                    marked: false,
                }
            };
            out.lines.push(Line {
                segs: vec![
                    lead,
                    Seg {
                        text: row,
                        tone: Tone::Text,
                        marked: false,
                    },
                ],
                fill: Tone::Text,
                entry: Some(at),
            });
        }
        out.files.push((at, start..out.lines.len()));
    }
}

fn open_file(state: &State, file: &File, width: usize, out: &mut Layout) {
    rows(
        &shape(&file.change.path),
        width,
        Tone::Heading,
        &mut out.lines,
    );
    if let Some(notice) = &state.notice {
        rows(notice, width, Tone::Warning, &mut out.lines);
    }
    let first = out.lines.len();
    rows(&State::file_words(file), width, Tone::Muted, &mut out.lines);
    for (label, side) in [("Before", &file.before), ("After", &file.after)] {
        if let Some(words) = side_words(label, side) {
            let tone = match side {
                Side::Text(read) => status_tone(read),
                Side::Absent => Tone::Muted,
            };
            rows(&words, width, tone, &mut out.lines);
        }
    }
    out.status = first..out.lines.len();
    let start = out.lines.len();
    match &file.shown {
        Shown::Hunks(hunks) | Shown::Plain { hunks, .. } => {
            hunk_lines(hunks, width, &mut out.lines);
        }
        Shown::Nothing | Shown::Same | Shown::LineBreakOnly | Shown::TooLarge => {}
    }
    out.diff = start..out.lines.len();
}

fn digits(hunks: &[Hunk]) -> usize {
    let top = hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .flat_map(|l| [l.old, l.new])
        .flatten()
        .max()
        .unwrap_or(0);
    top.max(1).to_string().len()
}

fn fill_of(kind: LineKind) -> Tone {
    match kind {
        LineKind::Same => Tone::Text,
        LineKind::Added => Tone::Added,
        LineKind::Removed => Tone::Removed,
    }
}

fn hunk_lines(hunks: &[Hunk], width: usize, out: &mut Vec<Line>) {
    let d = digits(hunks);
    // Line numbers, the sign and the text; when that leaves the text too narrow, the sign
    // and the text only.
    let numbered = width >= 2 * d + 3 + MIN_TEXT;
    let prefix = if numbered { 2 * d + 3 } else { 1 };
    let room = width.saturating_sub(prefix).max(1);
    for hunk in hunks {
        rows(&hunk.header, width, Tone::Hunk, out);
        for line in &hunk.lines {
            diff_line(line, d, numbered, prefix, room, out);
        }
    }
}

fn diff_line(
    line: &DiffLine,
    d: usize,
    numbered: bool,
    prefix: usize,
    room: usize,
    out: &mut Vec<Line>,
) {
    let fill = fill_of(line.kind);
    let sign = match line.kind {
        LineKind::Same => ' ',
        LineKind::Added => '+',
        LineKind::Removed => '-',
    };
    let number = |n: Option<usize>| match n {
        Some(n) => format!("{n:>d$}"),
        None => " ".repeat(d),
    };
    let rope = ropey::Rope::from_str(&line.text);
    let mut spans = line_rows(&rope, 0, room, 4);
    if spans.is_empty() {
        // An empty line still takes its row.
        spans.push(theorem_workbench_text::layout::Row {
            line: 0,
            index: 0,
            start: 0,
            end: 0,
            last: true,
        });
    }
    for (n, row) in spans.iter().enumerate() {
        let (bs, be) = (rope.char_to_byte(row.start), rope.char_to_byte(row.end));
        let mut segs = Vec::new();
        if numbered {
            let gutter = if n == 0 {
                format!("{} {} ", number(line.old), number(line.new))
            } else {
                " ".repeat(2 * d + 2)
            };
            segs.push(Seg {
                text: gutter,
                tone: Tone::Gutter,
                marked: false,
            });
        }
        segs.push(Seg {
            text: if n == 0 { sign } else { ' ' }.to_string(),
            tone: fill,
            marked: false,
        });
        debug_assert_eq!(
            segs.iter().map(|s| s.text.chars().count()).sum::<usize>(),
            prefix
        );
        segs.extend(split_marked(&line.text, bs, be, &line.words, fill));
        out.push(Line {
            segs,
            fill,
            entry: None,
        });
    }
}

/// `text[start..end]` as segments, the parts inside a changed word marked.
fn split_marked(
    text: &str,
    start: usize,
    end: usize,
    words: &[Range<usize>],
    tone: Tone,
) -> Vec<Seg> {
    let seg = |from: usize, to: usize, marked: bool| Seg {
        text: text[from..to].to_owned(),
        tone,
        marked,
    };
    let mut out = Vec::new();
    let mut at = start;
    for word in words {
        if word.end <= at || word.start >= end {
            continue;
        }
        let (s, e) = (word.start.max(at), word.end.min(end));
        if s > at {
            out.push(seg(at, s, false));
        }
        if e > s {
            out.push(seg(s, e, true));
            at = e;
        }
    }
    if at < end {
        out.push(seg(at, end, false));
    }
    out
}

fn style_of(tone: Tone, styles: &ChangesStyles) -> Style {
    match tone {
        Tone::Text => styles.text,
        Tone::Muted => styles.muted,
        Tone::Heading => styles.heading,
        Tone::Error => styles.error,
        Tone::Warning => styles.warning,
        Tone::Added => styles.added_line,
        Tone::Removed => styles.removed_line,
        Tone::Hunk => styles.hunk_header,
        Tone::Gutter => styles.gutter,
        Tone::Letter('A') => styles.letter_added,
        Tone::Letter('D') => styles.letter_deleted,
        Tone::Letter('M') => styles.letter_changed,
        Tone::Letter(_) => styles.muted,
    }
}

fn words_of(tone: Tone, styles: &ChangesStyles) -> Style {
    match tone {
        Tone::Added => styles.added_words,
        Tone::Removed => styles.removed_words,
        _ => Style::default(),
    }
}

/// How many rows at the foot the key hints take in a pane of `height`, and so how many
/// remain for the document.
pub(crate) fn hint_rows(layout: &Layout, height: u16) -> u16 {
    if height >= HINT_FROM_HEIGHT {
        layout.hint.len().min(2) as u16
    } else {
        0
    }
}

pub(crate) struct Paint<'a> {
    pub state: &'a State,
    pub layout: &'a Layout,
    pub scroll: usize,
    pub focused: bool,
    pub styles: &'a ChangesStyles,
}

pub(crate) fn draw(p: &Paint, area: Rect, buf: &mut Buffer) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let base = p.styles.text;
    paint(buf, area, base);
    let foot = hint_rows(p.layout, area.height);
    let body = area.height - foot;
    for row in 0..body {
        let Some(line) = p.layout.lines.get(p.scroll + row as usize) else {
            break;
        };
        let rect = Rect::new(area.x, area.y + row, area.width, 1);
        let on_cursor = line.entry.is_some() && line.entry == Some(p.state.cursor);
        let fill = if on_cursor {
            if p.focused {
                p.styles.cursor
            } else {
                p.styles.cursor_idle
            }
        } else {
            style_of(line.fill, p.styles)
        };
        paint(buf, rect, fill);
        let mut x = area.x;
        let mut left = area.width as usize;
        for seg in &line.segs {
            if left == 0 {
                break;
            }
            let mut style = if on_cursor {
                fill
            } else {
                match seg.tone {
                    Tone::Gutter => fill.patch(p.styles.gutter),
                    tone if tone == line.fill => fill,
                    tone => style_of(tone, p.styles),
                }
            };
            if seg.marked {
                style = style.patch(words_of(line.fill, p.styles));
            }
            let used = put(buf, x, rect.y, left, &seg.text, style);
            x += used as u16;
            left -= used;
        }
    }
    for (n, line) in p.layout.hint.iter().take(foot as usize).enumerate() {
        let y = area.y + body + n as u16;
        for seg in &line.segs {
            put(
                buf,
                area.x,
                y,
                area.width as usize,
                &seg.text,
                p.styles.muted,
            );
        }
    }
}

fn act(id: &str, reason: Option<&str>) -> NodeAction {
    NodeAction {
        id: ActionId::new(id),
        enabled: reason.is_none(),
        reason: reason.map(str::to_owned),
    }
}

/// The part of `range` (document lines) that is on screen, as a rect in `area`.
fn rect_of(range: &Range<usize>, scroll: usize, body: u16, area: Rect) -> Rect {
    let first = range.start.max(scroll);
    let last = range.end.min(scroll + body as usize);
    let height = last.saturating_sub(first) as u16;
    let y = area.y + (first.saturating_sub(scroll) as u16).min(body.saturating_sub(1));
    Rect::new(area.x, y, area.width, height)
}

/// The tree rooted at a region named "Delegation changes". Every node is bound to the
/// delegation resource, and none offers an action that changes anything.
pub(crate) fn semantics(
    p: &Paint,
    id: &str,
    area: Rect,
    resource: &ResourceRef,
    loading: bool,
) -> Vec<Node> {
    let state = p.state;
    let body = area.height.saturating_sub(hint_rows(p.layout, area.height));
    let mut root = Node::new(id, Role::Region, "Delegation changes", area);
    root.state.busy = loading;
    root.state.focused = p.focused;
    let mut nodes = Vec::new();

    let status_text: String = p
        .layout
        .lines
        .get(p.layout.status.clone())
        .unwrap_or(&[])
        .iter()
        .map(Line::text)
        .collect::<Vec<_>>()
        .join(" ");
    let mut status = Node::new(
        &format!("{id}/status"),
        Role::Status,
        &status_text,
        rect_of(&p.layout.status, p.scroll, body, area),
    );
    status.state.busy = loading;
    root.children.push(status.id.clone());
    nodes.push(status);

    match &state.file {
        None => {
            let changes = state.changes();
            let span = p.layout.files.first().map(|(_, r)| r.start).unwrap_or(0)
                ..p.layout.files.last().map(|(_, r)| r.end).unwrap_or(0);
            let mut list = Node::new(
                &format!("{id}/files"),
                Role::List,
                "Changed files",
                rect_of(&span, p.scroll, body, area),
            );
            list.actions = vec![act(actions::REFRESH, None)];
            for (at, range) in &p.layout.files {
                let change = &changes[*at];
                let mut name = format!("{}, {}", shape(&change.path), change_word(change.change));
                if change.binary {
                    name.push_str(", binary");
                }
                let mut item = Node::new(
                    &format!("{id}/file/{at}"),
                    Role::ListItem,
                    &name,
                    rect_of(range, p.scroll, body, area),
                );
                item.pos_in_set = Some((*at + 1) as u16);
                item.set_size = Some(changes.len() as u16);
                item.state.selected = *at == state.cursor;
                item.state.focused = *at == state.cursor && p.focused;
                item.actions = vec![act(actions::OPEN, None)];
                list.children.push(item.id.clone());
                nodes.push(item);
            }
            root.children.push(list.id.clone());
            nodes.push(list);
            root.actions = vec![act(actions::REFRESH, None)];
        }
        Some(file) => {
            let mut doc = Node::new(
                &format!("{id}/diff"),
                Role::Document,
                &format!("Before and after of {}", shape(&file.change.path)),
                rect_of(&p.layout.diff, p.scroll, body, area),
            );
            doc.state.busy = file.waiting();
            doc.state.description = Some(State::file_words(file));
            doc.actions = vec![act(actions::BACK, None), act(actions::REFRESH, None)];
            let text: Vec<String> = p
                .layout
                .lines
                .get(p.layout.diff.clone())
                .unwrap_or(&[])
                .iter()
                .map(Line::text)
                .collect();
            if !text.is_empty() {
                doc = doc.with_text(&text.join("\n"));
            }
            root.children.push(doc.id.clone());
            nodes.push(doc);
            root.actions = vec![act(actions::BACK, None), act(actions::REFRESH, None)];
        }
    }
    let mut all = vec![root];
    all.extend(nodes);
    for node in &mut all {
        node.binding = resource.clone();
    }
    all
}
