//! The transcript's blocks: what a finished turn's activity folds to, the
//! header lines of thinking and tool calls, the outlined block of a running
//! command, the header of code the agent writes, fenced code drawn as a block,
//! and how much of an agent's activity is shown.
//!
//! Written for this crate (ledger row L29); the arrangement is translated from
//! the Delta desktop app as the owner's recording shows it, nothing copied.
//! Every colour is a role the palette already has. The fences of a code block
//! are found by the workbench's own Markdown parse (`theorem-workbench-markdown`),
//! the box is Ratatui's rounded border set, and the diff the header counts is
//! the one the owner sends.

use ratatui::{
    style::{Modifier, Style},
    symbols::border,
    text::{Line, Span},
};
use theorem_workbench_markdown::{MarkdownBlock, block_ranges, markdown_blocks};
use unicode_width::UnicodeWidthStr;

use crate::{DiffLine, INDENT, Part, Token, palette, token_line};

/// How much of what an agent does the transcript shows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Activity {
    /// Every thinking, tool call and diff open as it happens; nothing folds.
    All,
    /// One header line each; a finished turn's activity folds to its summary.
    #[default]
    Headers,
    /// Every turn's activity is its summary line; code the agent writes is its header.
    Summary,
}

impl Activity {
    pub(crate) const ALL: [Activity; 3] = [Activity::All, Activity::Headers, Activity::Summary];

    /// The word a saved layout and an action name it by.
    pub(crate) fn word(self) -> &'static str {
        match self {
            Activity::All => "everything",
            Activity::Headers => "headers",
            Activity::Summary => "summary",
        }
    }

    /// What the panel says it shows, in the person's words.
    pub(crate) fn label(self) -> &'static str {
        match self {
            Activity::All => "activity: everything",
            Activity::Headers => "activity: headers",
            Activity::Summary => "activity: summary",
        }
    }

    pub(crate) fn named(word: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|level| level.word() == word)
    }

    pub(crate) fn next(self) -> Self {
        match self {
            Activity::All => Activity::Headers,
            Activity::Headers => Activity::Summary,
            Activity::Summary => Activity::All,
        }
    }
}

/// What a block of the transcript is, for the keys, the pointer and the semantic tree.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BlockKind {
    Thinking,
    Summary,
    Tool,
    Diff,
    Running,
}

/// A block's header line as the last build laid it out.
#[derive(Clone, Debug)]
pub(crate) struct BlockRow {
    /// The transcript line its header is.
    pub line: usize,
    /// What the person's open or close of it is kept under.
    pub key: String,
    pub kind: BlockKind,
    /// Its name for the semantic tree, made safe to show.
    pub name: String,
    /// Open or closed; none for a block that does neither.
    pub expanded: Option<bool>,
    /// The file it wrote, and where.
    pub open: Option<crate::Open>,
    /// The columns of the header the file's path takes, from the body's left edge.
    pub path_cols: Option<(u16, u16)>,
    /// The message it belongs to, by index.
    pub message: usize,
    /// For code the agent writes: the lines it adds and removes.
    pub counts: Option<(usize, usize)>,
    /// What a closed summary holds, one header per line.
    pub holds: Option<String>,
}

/// A tool call's kind, by the words its name is made of.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ToolKind {
    Search,
    Command,
    Read,
    Edit,
    Other,
}

fn tool_kind(name: &str) -> ToolKind {
    let name = name.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| name.contains(w));
    if has(&["grep", "search", "find", "glob"]) {
        ToolKind::Search
    } else if has(&["run", "bash", "shell", "exec", "command", "terminal"]) {
        ToolKind::Command
    } else if has(&["read", "view", "cat", "open", "list", "ls"]) {
        ToolKind::Read
    } else if has(&["edit", "write", "patch", "replace", "create"]) {
        ToolKind::Edit
    } else {
        ToolKind::Other
    }
}

/// "once", "twice", "3 times".
fn times(n: usize) -> String {
    match n {
        1 => "once".to_owned(),
        2 => "twice".to_owned(),
        n => format!("{n} times"),
    }
}

/// "a command", "2 commands".
fn counted(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("a {one}")
    } else {
        format!("{n} {many}")
    }
}

/// A run of activity in plain words: "Thought twice, ran 2 commands, searched once".
pub(crate) fn activity_words(parts: &[&Part]) -> String {
    let (mut thought, mut failed) = (0, 0);
    let mut kinds = [0usize; 5];
    for part in parts {
        match part {
            Part::Reasoning { .. } => thought += 1,
            Part::Tool { name, status, .. } => {
                let at = match tool_kind(name) {
                    ToolKind::Command => 0,
                    ToolKind::Search => 1,
                    ToolKind::Read => 2,
                    ToolKind::Edit => 3,
                    ToolKind::Other => 4,
                };
                kinds[at] += 1;
                failed += usize::from(status == "error");
            }
            _ => {}
        }
    }
    let mut words = Vec::new();
    if thought > 0 {
        words.push(format!("thought {}", times(thought)));
    }
    if kinds[0] > 0 {
        words.push(format!("ran {}", counted(kinds[0], "command", "commands")));
    }
    if kinds[1] > 0 {
        words.push(format!("searched {}", times(kinds[1])));
    }
    if kinds[2] > 0 {
        words.push(format!("read {}", counted(kinds[2], "file", "files")));
    }
    if kinds[3] > 0 {
        words.push(format!("edited {}", counted(kinds[3], "file", "files")));
    }
    if kinds[4] > 0 {
        words.push(format!("used {}", counted(kinds[4], "tool", "tools")));
    }
    if failed > 0 {
        words.push(format!("{failed} failed"));
    }
    let text = words.join(", ");
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => text,
    }
}

/// A span of time the snapshot measured, short: "4s", "1m 05s", "2h 03m".
pub(crate) fn duration(ms: f64) -> String {
    let secs = (ms.max(0.0) / 1000.0).floor() as u64;
    match secs {
        0 => "<1s".to_owned(),
        1..60 => format!("{secs}s"),
        60..3600 => format!("{}m {:02}s", secs / 60, secs % 60),
        _ => format!("{}h {:02}m", secs / 3600, secs / 60 % 60),
    }
}

/// How long something took or has taken, when the snapshot carries both ends.
pub(crate) fn took(started: Option<f64>, ended: Option<f64>) -> Option<String> {
    Some(duration(ended? - started?))
}

/// The open or closed mark at a header's end.
fn chevron(open: bool) -> &'static str {
    if open { "▾" } else { "▸" }
}

/// A quiet header: thinking, or a folded run of activity, with its open mark.
pub(crate) fn quiet_header(text: &str, time: Option<&str>, open: bool) -> Line<'static> {
    let p = palette();
    let mut spans = vec![
        Span::raw(INDENT),
        Span::styled(text.to_owned(), Style::new().fg(p.muted)),
    ];
    if let Some(time) = time {
        spans.push(Span::styled(
            format!("  {time}"),
            Style::new().fg(p.text_disabled()),
        ));
    }
    spans.push(Span::styled(
        format!(" {}", chevron(open)),
        Style::new().fg(p.muted),
    ));
    Line::from(spans)
}

/// The prose of a thinking block, under its header.
pub(crate) fn thought_lines(text: &str) -> Vec<Line<'static>> {
    let style = Style::new()
        .fg(palette().muted)
        .add_modifier(Modifier::ITALIC);
    text.lines()
        .map(|row| {
            Line::from(vec![
                Span::raw(INDENT),
                Span::raw("  "),
                Span::styled(row.to_owned(), style),
            ])
        })
        .collect()
}

/// Text cut to `cols` columns, an ellipsis marking the cut.
fn fit(text: &str, cols: usize) -> String {
    if text.width() <= cols {
        return text.to_owned();
    }
    let mut out = String::new();
    for c in text.chars() {
        if out.width() + unicode_width::UnicodeWidthChar::width(c).unwrap_or(0) + 1 > cols {
            break;
        }
        out.push(c);
    }
    out.push('…');
    out
}

/// The most output lines a running command's block shows: the tail.
pub(crate) const TAIL: usize = 6;

/// A running command as an outlined block: its name and command on the top
/// edge with how long it has run, the tail of its output inside.
pub(crate) fn running_block(
    name: &str,
    summary: &str,
    tail: &[Vec<Token>],
    elapsed: Option<&str>,
    width: u16,
) -> Vec<Line<'static>> {
    let p = palette();
    let set = border::ROUNDED;
    // No band behind it: the accent outline and the coloured text carry the
    // state; only a diff is drawn on a ground (owner, 2026-11-22).
    let edge = Style::new().fg(p.accent);
    let w = usize::from(width).saturating_sub(INDENT.len());
    if w < 12 {
        return vec![crate::tool_row(name, summary, "running", false, width)];
    }
    let mut lines = Vec::new();
    // ╭─ name  command ───── 12s ─╮
    let right = match elapsed {
        Some(time) => format!(" {time} {}{}", set.horizontal_top, set.top_right),
        None => format!(" {}{}", set.horizontal_top, set.top_right),
    };
    let left = format!("{}{} ", set.top_left, set.horizontal_top);
    let room = w.saturating_sub(left.width() + right.width() + name.width() + 2);
    let summary = fit(&summary.replace('\n', " "), room);
    let fill =
        w.saturating_sub(left.width() + name.width() + 1 + summary.width() + 1 + right.width());
    lines.push(Line::from(vec![
        Span::raw(INDENT),
        Span::styled(left, edge),
        Span::styled(
            name.to_owned(),
            Style::new().fg(p.bright).add_modifier(Modifier::BOLD),
        ),
        Span::raw(" "),
        Span::styled(summary, Style::new().fg(p.muted)),
        Span::raw(" "),
        Span::styled(set.horizontal_top.repeat(fill), edge),
        Span::styled(right, edge),
    ]));
    let inner = w.saturating_sub(4);
    for tokens in tail.iter().skip(tail.len().saturating_sub(TAIL)) {
        let mut spans = vec![
            Span::raw(INDENT),
            Span::styled(format!("{} ", set.vertical_left), edge),
        ];
        let mut used = 0;
        for span in token_line(tokens) {
            let left = inner.saturating_sub(used);
            if left == 0 {
                break;
            }
            let text = fit(&span.content, left);
            used += text.width();
            spans.push(Span::styled(text, span.style));
        }
        spans.push(Span::raw(" ".repeat(inner.saturating_sub(used))));
        spans.push(Span::styled(format!(" {}", set.vertical_right), edge));
        lines.push(Line::from(spans));
    }
    lines.push(Line::from(vec![
        Span::raw(INDENT),
        Span::styled(
            format!(
                "{}{}{}",
                set.bottom_left,
                set.horizontal_bottom.repeat(w.saturating_sub(2)),
                set.bottom_right
            ),
            edge,
        ),
    ]));
    lines
}

/// The lines a diff adds and removes.
pub(crate) fn counts(diff: &[DiffLine]) -> (usize, usize) {
    diff.iter()
        .fold((0, 0), |(a, r), line| match line.k.as_str() {
            "add" => (a + 1, r),
            "del" => (a, r + 1),
            _ => (a, r),
        })
}

/// What a diff block's header adds after its path: the counts and the open mark.
pub(crate) fn diff_extra(added: usize, removed: usize, open: bool) -> Vec<Span<'static>> {
    let p = palette();
    vec![
        Span::raw("  "),
        Span::styled(format!("+{added}"), Style::new().fg(p.diff_added_mark())),
        Span::raw(" "),
        Span::styled(
            format!("−{removed}"),
            Style::new().fg(p.diff_removed_mark()),
        ),
        Span::styled(format!(" {}", chevron(open)), Style::new().fg(p.muted)),
    ]
}

/// A piece of an answer's Markdown: prose, or a fenced or indented code block.
pub(crate) enum Piece {
    Prose(String),
    Code(String),
}

/// An answer's Markdown split where its code blocks are, by the workbench's own
/// parse: prose stays Markdown, a code block is its text without the fences.
/// A fence still being written runs to the end, as Markdown reads it.
pub(crate) fn pieces(text: &str) -> Vec<Piece> {
    if !text.contains("```") && !text.contains("~~~") && !text.contains("\n    ") {
        return vec![Piece::Prose(text.to_owned())];
    }
    let mut out: Vec<Piece> = Vec::new();
    let mut prose: Option<(usize, usize)> = None;
    let flush = |out: &mut Vec<Piece>, prose: &mut Option<(usize, usize)>| {
        if let Some((from, to)) = prose.take() {
            out.push(Piece::Prose(text[from..to].to_owned()));
        }
    };
    for range in block_ranges(text) {
        let slice = &text[range.clone()];
        match markdown_blocks(slice).as_slice() {
            [MarkdownBlock::Code { text: code, .. }] => {
                flush(&mut out, &mut prose);
                out.push(Piece::Code(
                    code.strip_suffix('\n').unwrap_or(code).to_owned(),
                ));
            }
            _ => {
                prose = Some(match prose {
                    Some((from, _)) => (from, range.end),
                    None => (range.start, range.end),
                });
            }
        }
    }
    flush(&mut out, &mut prose);
    out
}

/// A code block's lines with no fences, indented under the prose, in their
/// syntax colours on no band.
pub(crate) fn code_block(code: &[Vec<Token>]) -> Vec<Line<'static>> {
    code.iter()
        .map(|tokens| {
            let mut spans = vec![Span::raw(INDENT), Span::raw(" ")];
            spans.extend(token_line(tokens));
            Line::from(spans)
        })
        .collect()
}

/// Plain code as tokens, one line each.
pub(crate) fn plain_tokens(code: &str) -> Vec<Vec<Token>> {
    code.split('\n')
        .map(|row| {
            vec![Token {
                t: row.to_owned(),
                c: None,
                e: false,
            }]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str, status: &str) -> Part {
        Part::Tool {
            name: name.to_owned(),
            summary: String::new(),
            status: status.to_owned(),
            output: None,
            open: None,
            id: None,
            started_at_ms: None,
            ended_at_ms: None,
        }
    }

    #[test]
    fn a_run_of_activity_reads_in_plain_words() {
        let think = Part::Reasoning {
            text: String::new(),
            started_at_ms: None,
            ended_at_ms: None,
        };
        let a = tool("run_command", "complete");
        let b = tool("bash", "complete");
        let c = tool("grep", "complete");
        let parts = [&think, &a, &think, &b, &c];
        assert_eq!(
            activity_words(&parts),
            "Thought twice, ran 2 commands, searched once"
        );
        let e = tool("read_file", "error");
        assert_eq!(activity_words(&[&e]), "Read a file, 1 failed");
    }

    #[test]
    fn durations_are_short() {
        assert_eq!(duration(4_200.0), "4s");
        assert_eq!(duration(500.0), "<1s", "under a second is not 0s");
        assert_eq!(duration(65_000.0), "1m 05s");
        assert_eq!(duration(7_380_000.0), "2h 03m");
        assert_eq!(took(Some(1_000.0), None), None);
        assert_eq!(took(Some(1_000.0), Some(3_500.0)).as_deref(), Some("2s"));
    }

    #[test]
    fn fenced_code_is_lifted_out_without_its_fences_and_an_open_fence_runs_to_the_end() {
        let text = "Before.\n\n```rust\nfn main() {}\n```\n\nAfter.";
        let got = pieces(text);
        assert!(matches!(&got[0], Piece::Prose(p) if p.trim() == "Before."));
        assert!(matches!(&got[1], Piece::Code(c) if c == "fn main() {}"));
        assert!(matches!(&got[2], Piece::Prose(p) if p.trim() == "After."));
        let open = pieces("Now:\n\n```ts\nconst a = 1\n");
        assert!(matches!(&open[1], Piece::Code(c) if c == "const a = 1"));
    }

    #[test]
    fn the_running_block_is_as_wide_as_the_body_and_keeps_only_the_tail() {
        let tail: Vec<Vec<Token>> = (0..10)
            .flat_map(|i| plain_tokens(&format!("line {i}")))
            .collect();
        let lines = running_block("run_command", "cargo test", &tail, Some("12s"), 60);
        assert_eq!(lines.len(), TAIL + 2);
        for line in &lines {
            assert_eq!(line.width(), 60);
        }
        let top: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(top.contains("run_command") && top.contains("cargo test") && top.contains("12s"));
        let body: String = lines[1].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(body.contains("line 4"));
    }

    #[test]
    fn the_levels_cycle_and_are_named_by_their_word() {
        assert_eq!(Activity::default(), Activity::Headers);
        assert_eq!(Activity::Headers.next(), Activity::Summary);
        assert_eq!(Activity::Summary.next(), Activity::All);
        for level in Activity::ALL {
            assert_eq!(Activity::named(level.word()), Some(level));
        }
    }
}
