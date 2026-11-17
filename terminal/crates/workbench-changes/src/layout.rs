//! The panel as rows: which rows the list holds and where the fixed parts sit.
//!
//! Translated from ELY-Open-Source/ELYTerminal at fbb536ec8f6e1466fa8c736967671ebf99a34080
//! `src/git/panel/view.rs` (blob 9e1cfe63f7490d521efe1ddf1675c6a738a624e7), `Render for
//! GitPanel`: the order of the parts (branch, error, changes, commit box, recent commits)
//! and what each state of the panel shows in place of the list. The donor's flex layout
//! becomes one row per line of a terminal.
//!
//! Translated from ELY-Open-Source/Ely-GPUI-Components at 294a8323c08a06bd8e7782d16acee43b6bb0c5eb
//! `src/git/changes.rs` (blob 9591530a7aadc9f88b726afd97d81a1079ecc795): the section
//! headings with their counts, and a row's actions per section.

use ratatui::layout::Rect;
use theorem_workbench_core::completion::{BranchInfo, ConflictSides};

use crate::diff::{DiffLine, Hunk, pair_places};
use crate::model::{
    BranchList, Changes, DiffLayout, DiffState, LogState, Mode, PanelState, Problem, ReadBody,
    ReadKind, SUBJECT,
};
use crate::status::{Change, LISTED, RowKey, Section};
use crate::text::{width, wrap};
use theorem_workbench_text::visible::visible;

/// How a line of text is toned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tone {
    Plain,
    Muted,
    Warning,
    Error,
    /// A diff line a commit added or removed, in a read view.
    Added,
    Removed,
    /// The row the cursor is on in a read view's list.
    Cursor,
}

/// One line of the scrolling list.
#[derive(Debug)]
pub(crate) enum Row<'a> {
    Header {
        section: Section,
        count: usize,
    },
    File {
        key: RowKey,
        change: &'a Change,
        expanded: bool,
    },
    Hunk {
        hunk: &'a Hunk,
        folded: bool,
        current: bool,
    },
    Line {
        line: &'a DiffLine,
        digits: usize,
    },
    Pair {
        left: Option<&'a DiffLine>,
        right: Option<&'a DiffLine>,
        digits: usize,
    },
    /// A line of words: a state, a note under a diff, a count. `wrap` says whether the
    /// words may need more than one row; [`rows`] has broken those already, so by the
    /// time a row is drawn it fits the pane.
    Text {
        text: String,
        tone: Tone,
        indent: u16,
        wrap: bool,
    },
    Branch {
        info: &'a BranchInfo,
        cursor: bool,
    },
}

impl Row<'_> {
    pub(crate) fn is_file(&self, wanted: &RowKey) -> bool {
        matches!(self, Row::File { key, .. } if key == wanted)
    }
}

/// Words for the person: wrapped to the pane on spaces.
fn text(text: impl Into<String>, tone: Tone) -> Row<'static> {
    Row::Text {
        text: text.into(),
        tone,
        indent: 0,
        wrap: true,
    }
}

/// A line of a file, a diff, a blame or a history: one row, cut at the pane edge.
fn content(text: impl Into<String>, tone: Tone) -> Row<'static> {
    Row::Text {
        text: text.into(),
        tone,
        indent: 0,
        wrap: false,
    }
}

pub(crate) fn problem_tone(problem: &Problem) -> Tone {
    match problem {
        Problem::Refused { .. } | Problem::Failed { .. } => Tone::Error,
        Problem::Uncertain { .. } | Problem::Stopped { .. } => Tone::Warning,
    }
}

/// Digits of the largest line number in a diff, at least two.
fn digits(hunks: &[Hunk]) -> usize {
    let most = hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .flat_map(|l| [l.old, l.new])
        .flatten()
        .max()
        .unwrap_or(0);
    most.to_string().len().max(2)
}

fn diff_rows<'a>(model: &'a Changes, key: &RowKey, split: bool, out: &mut Vec<Row<'a>>) {
    let Some(view) = model.diffs.get(key) else {
        return;
    };
    let note = |words: &str, tone| Row::Text {
        text: words.to_owned(),
        tone,
        indent: 2,
        wrap: true,
    };
    if view.stale {
        out.push(note(
            "Out of date: this file changed after the diff was read. Reload to read it again.",
            Tone::Warning,
        ));
    }
    match &view.state {
        DiffState::Loading => out.push(note("Reading the diff...", Tone::Muted)),
        DiffState::Binary => out.push(note("A binary file: there are no lines to show.", Tone::Muted)),
        DiffState::NoLines => out.push(note("No line changes.", Tone::Muted)),
        DiffState::Folder => out.push(note(
            "An untracked folder: it has no lines of its own.",
            Tone::Muted,
        )),
        DiffState::NoStatus => out.push(note(
            "The host did not report this file's status, so there is nothing to compare.",
            Tone::Muted,
        )),
        DiffState::Problem(problem) => out.push(Row::Text {
            text: problem.text(),
            tone: problem_tone(problem),
            indent: 2,
            wrap: true,
        }),
        DiffState::Unreadable(why) => {
            out.push(note(&format!("The diff could not be read: {why}"), Tone::Error))
        }
        DiffState::Outdated => out.push(note(
            "The answer was for an earlier state of the repository and was dropped. Reload to read the diff again.",
            Tone::Warning,
        )),
        DiffState::Hunks(hunks) => {
            let width = digits(hunks);
            for (index, hunk) in hunks.iter().enumerate() {
                let folded = view.folded.contains(&index);
                out.push(Row::Hunk {
                    hunk,
                    folded,
                    current: index == view.hunk,
                });
                if folded {
                    continue;
                }
                if split {
                    for (left, right) in pair_places(&hunk.lines) {
                        out.push(Row::Pair {
                            left: left.map(|i| &hunk.lines[i]),
                            right: right.map(|i| &hunk.lines[i]),
                            digits: width,
                        });
                    }
                } else {
                    for line in &hunk.lines {
                        out.push(Row::Line {
                            line,
                            digits: width,
                        });
                    }
                }
            }
        }
    }
}

/// The rows of the scrolling list, in a pane `width` cells wide. `split` is whether the
/// diffs are drawn side by side at this width. Words that do not fit a row are broken
/// onto more rows here, on spaces, so no row is cut when it is drawn.
pub(crate) fn rows(model: &Changes, split: bool, width: u16) -> Vec<Row<'_>> {
    let mut out = Vec::new();
    for row in unwrapped_rows(model, split) {
        match row {
            Row::Text {
                text,
                tone,
                indent,
                wrap: true,
            } => {
                // Drawn one cell in, then the indent.
                let room = usize::from(width).saturating_sub(usize::from(indent) + 1);
                for line in crate::text::wrap(&text, room) {
                    out.push(Row::Text {
                        text: line,
                        tone,
                        indent,
                        wrap: false,
                    });
                }
            }
            other => out.push(other),
        }
    }
    out
}

fn unwrapped_rows(model: &Changes, split: bool) -> Vec<Row<'_>> {
    match model.mode {
        Mode::Branches => return branch_rows(model),
        Mode::Read if model.read.is_some() => return read_rows(model),
        _ => {}
    }
    let mut out = Vec::new();
    let split = split && model.layout == DiffLayout::Split;
    let Some(snapshot) = model.snapshot.as_ref() else {
        match model.state() {
            PanelState::Loading => out.push(text("Reading changes...", Tone::Muted)),
            PanelState::Refused { code, reason } => {
                out.push(text(
                    format!("Source control is unavailable ({code})"),
                    Tone::Error,
                ));
                out.push(text(visible(&reason), Tone::Muted));
            }
            PanelState::Uncertain { reason } => {
                out.push(text(
                    "Unknown result: the repository was not read.",
                    Tone::Warning,
                ));
                out.push(text(visible(&reason), Tone::Muted));
                out.push(text("Refresh to read it again.", Tone::Muted));
            }
            PanelState::Failed { reason } => {
                out.push(text("The repository could not be read.", Tone::Error));
                out.push(text(visible(&reason), Tone::Muted));
            }
            PanelState::Empty | PanelState::Ready => {}
        }
        return out;
    };
    if snapshot.groups.is_empty() {
        out.push(text("No changes", Tone::Muted));
        return out;
    }
    if let Some((listed, total)) = snapshot.groups.cut() {
        out.push(text(
            format!("Listing {listed} of {total} changes"),
            Tone::Muted,
        ));
    }
    for section in Section::ALL {
        let changes = snapshot.groups.section(section);
        if changes.is_empty() {
            continue;
        }
        out.push(Row::Header {
            section,
            count: changes.len(),
        });
        for change in changes.iter().take(LISTED) {
            let key = RowKey::new(section, change.path.clone());
            let expanded = model.diffs.contains_key(&key);
            out.push(Row::File {
                key: key.clone(),
                change,
                expanded,
            });
            if expanded {
                diff_rows(model, &key, split, &mut out);
            }
        }
    }
    out
}

/// The sides of a conflicted file: what to do about it, then ours, theirs and the base.
/// A side the host does not have is said to be absent, which differs from an empty file.
fn conflict_rows(sides: &ConflictSides, out: &mut Vec<Row<'_>>) {
    if !sides.conflict {
        out.push(text(
            "The file is no longer in conflict. Refresh the list.",
            Tone::Warning,
        ));
    } else if sides.binary {
        out.push(text(
            "This file is binary. Its sides cannot be shown as text.",
            Tone::Warning,
        ));
        out.push(text("o take ours   t take theirs", Tone::Muted));
    } else {
        out.push(text(
            "o take ours   t take theirs   e merge by hand in the editor",
            Tone::Muted,
        ));
    }
    let binary = sides.binary;
    let mut side = |title: &str, body: &Option<String>| {
        out.push(text(String::new(), Tone::Plain));
        out.push(text(title.to_owned(), Tone::Muted));
        match body {
            None => out.push(text("This side has no file.", Tone::Muted)),
            // A binary side carries no text; it exists, it is just not text.
            Some(_) if binary => out.push(text("Binary: not shown as text.", Tone::Muted)),
            Some(body) if body.is_empty() => out.push(text("The file is empty.", Tone::Muted)),
            Some(body) => {
                let digits = body.lines().count().to_string().len();
                for (at, line) in body.lines().enumerate() {
                    out.push(content(format!("{:>digits$} {line}", at + 1), Tone::Plain));
                }
            }
        }
    };
    side("Ours (this branch)", &sides.ours);
    side("Theirs (incoming)", &sides.theirs);
    if sides.base.is_some() {
        side("Base (the common ancestor)", &sides.base);
    }
}

/// What a file's read view lists: its heading, a way back, and the answer.
fn read_rows(model: &Changes) -> Vec<Row<'_>> {
    let Some(read) = &model.read else {
        return vec![];
    };
    let mut out = vec![
        text(read.kind.title(&read.path), Tone::Muted),
        text(
            if model.read_has_back() {
                "Esc goes back."
            } else {
                "Esc goes back to the changes."
            },
            Tone::Muted,
        ),
    ];
    match &read.body {
        ReadBody::Loading => out.push(text("Reading...", Tone::Muted)),
        ReadBody::Outdated => out.push(text(
            "The answer was for an earlier state of the repository and was dropped. Ask again to read it.",
            Tone::Warning,
        )),
        ReadBody::Problem(problem) => out.push(text(problem.text(), problem_tone(problem))),
        ReadBody::Blame(hunks) if hunks.is_empty() => {
            out.push(text("No lines are attributed.", Tone::Muted))
        }
        ReadBody::Blame(hunks) => {
            for hunk in hunks {
                let last = hunk.start_line + hunk.line_count.saturating_sub(1);
                let lines = if hunk.line_count <= 1 {
                    format!("{:>5}      ", hunk.start_line)
                } else {
                    format!("{:>5}-{:<5}", hunk.start_line, last)
                };
                let commit: String = hunk.commit.chars().take(7).collect();
                out.push(content(
                    format!("{lines} {commit} {}  {}", hunk.author, hunk.summary),
                    Tone::Plain,
                ));
            }
        }
        ReadBody::Text { exists: false, .. } => out.push(text(
            match &read.kind {
                ReadKind::Show(theorem_workbench_core::effect::ScmRef::Index) => {
                    "The index has no such file."
                }
                ReadKind::Revision { .. } => "The file did not exist in that commit.",
                _ => "HEAD has no such file.",
            },
            Tone::Muted,
        )),
        ReadBody::Text { text: body, .. } if body.is_empty() => out.push(text(
            match &read.kind {
                ReadKind::Commit { .. } => "This commit has no line changes.",
                _ => "The file is empty.",
            },
            Tone::Muted,
        )),
        ReadBody::Text { text: body, .. } if matches!(read.kind, ReadKind::Commit { .. }) => {
            for line in body.lines() {
                let tone = if line.starts_with("+++") || line.starts_with("---") {
                    Tone::Muted
                } else if line.starts_with('+') {
                    Tone::Added
                } else if line.starts_with('-') {
                    Tone::Removed
                } else if line.starts_with("@@") || line.starts_with("diff ") {
                    Tone::Muted
                } else {
                    Tone::Plain
                };
                out.push(content(line, tone));
            }
        }
        ReadBody::Text { text: body, .. } => {
            let digits = body.lines().count().to_string().len();
            for (at, line) in body.lines().enumerate() {
                out.push(content(format!("{:>digits$} {line}", at + 1), Tone::Plain));
            }
        }
        ReadBody::Conflict(sides) => conflict_rows(sides, &mut out),
        ReadBody::History(commits) if commits.is_empty() => {
            out.push(text("No commit changed this file.", Tone::Muted))
        }
        ReadBody::History(commits) => {
            for (at, entry) in commits.iter().enumerate() {
                let commit: String = entry.commit.chars().take(7).collect();
                // The chosen commit is told by its row's tone, not by a glyph.
                out.push(content(
                    format!("  {commit} {}  {}", entry.subject, entry.author),
                    if at == read.cursor { Tone::Cursor } else { Tone::Plain },
                ));
            }
        }
    }
    out
}

fn branch_rows(model: &Changes) -> Vec<Row<'_>> {
    let title = model
        .prompt
        .as_ref()
        .map_or("Switch branch", |p| p.kind.label());
    let mut out = vec![text(title, Tone::Muted)];
    let typing = model.prompt.is_some();
    match &model.branches {
        BranchList::Idle | BranchList::Loading => {
            out.push(text("Reading branches...", Tone::Muted))
        }
        BranchList::Outdated => out.push(text(
            "The branch list was for an earlier state of the repository and was dropped.",
            Tone::Warning,
        )),
        BranchList::Problem(problem) => {
            out.push(text(problem.text(), problem_tone(problem)));
            if typing {
                out.push(text("Type the name and press Enter.", Tone::Muted));
            }
        }
        BranchList::Ready(list) if list.is_empty() => out.push(text("No branches", Tone::Muted)),
        BranchList::Ready(_) => {
            let shown = model.candidates();
            if shown.is_empty() {
                out.push(text(
                    "No branch matches. Enter takes the name as typed.",
                    Tone::Muted,
                ));
            }
            for (at, info) in shown.into_iter().enumerate() {
                out.push(Row::Branch {
                    info,
                    cursor: at == model.branch_cursor && (!typing || model.prompt_picked()),
                });
            }
        }
    }
    out
}

/// A line above the list that says something about the whole panel.
pub(crate) fn banners(model: &Changes) -> Vec<(Tone, String)> {
    let mut out = Vec::new();
    if let Some(confirm) = &model.confirm {
        let (title, cost) = confirm.text();
        out.push((Tone::Warning, title));
        out.push((Tone::Muted, cost));
        out.push((Tone::Muted, CONFIRM_LINE.to_owned()));
    }
    if model.snapshot.is_some()
        && let Some(problem) = &model.status_problem
    {
        out.push((
            problem_tone(problem),
            format!(
                "The list is out of date: reading it again {}",
                problem.text()
            ),
        ));
    }
    for notice in &model.notices {
        out.push((problem_tone(&notice.problem), notice.text()));
        if matches!(notice.problem, Problem::Uncertain { .. }) {
            out.push((
                Tone::Muted,
                "Refresh and check before trying again.".to_owned(),
            ));
        }
    }
    for receipt in model.receipts() {
        out.push((Tone::Muted, receipt.text()));
        if let Some(draft) = receipt.draft_text() {
            out.push((Tone::Warning, draft));
        }
    }
    out.truncate(5);
    // Words from a reason, a path or a subject may hold escapes or overrides: the
    // banner spells them out, in the cells and in the semantic node alike.
    out.into_iter().map(|(t, l)| (t, visible(&l))).collect()
}

/// The confirmation's third line: the two answers, as they are clicked and as the keys
/// name them.
pub(crate) const CONFIRM_LINE: &str = "[ Confirm (y) ]  [ Cancel (n) ]";
/// Where the two answers start in [`CONFIRM_LINE`], and how wide each is.
const CONFIRM_AT: (u16, u16) = (0, 15);
const CANCEL_AT: (u16, u16) = (17, 14);
/// The answers one to a row, when [`CONFIRM_LINE`] does not fit the pane.
const CONFIRM_ROW: &str = "[ Confirm (y) ]";
const CANCEL_ROW: &str = "[ Cancel (n) ]";

/// The banners laid out in a pane `width` by `height`: each wrapped on spaces to the
/// width, whole banners dropped from the end when they do not all fit.
pub(crate) struct BannerRows {
    pub rows: Vec<(Tone, String)>,
    /// Each banner that is shown: its index in [`banners`], its first row and its rows.
    pub spans: Vec<(usize, usize, usize)>,
    /// The two answers of a confirmation: what a click there means, the row, the column
    /// and the width.
    pub answers: Vec<(Hit, usize, u16, u16)>,
}

pub(crate) fn banner_rows(model: &Changes, width: u16, height: u16) -> BannerRows {
    let all = banners(model);
    let w = usize::from(width).max(1);
    let confirming = model.confirm.is_some();
    let one_row = w >= width_of(CONFIRM_LINE);
    let mut blocks: Vec<(Tone, Vec<String>)> = all
        .iter()
        .enumerate()
        .map(|(i, (tone, line))| {
            let lines = if confirming && i == 2 {
                if one_row {
                    vec![CONFIRM_LINE.to_owned()]
                } else {
                    vec![CONFIRM_ROW.to_owned(), CANCEL_ROW.to_owned()]
                }
            } else {
                wrap(line, w)
            };
            (*tone, lines)
        })
        .collect();
    let third = usize::from(height / 3);
    let mut keep: Vec<usize> = blocks.iter().map(|_| 0).collect();
    if confirming {
        // The dialog gets the pane but for the branch row. When it is taller than that,
        // the answers stay, then the consequence, then the question's first rows.
        let mut room = usize::from(height.saturating_sub(1));
        for i in [2, 1, 0] {
            let len = blocks.get(i).map_or(0, |b| b.1.len());
            keep[i] = len.min(room);
            room -= keep[i];
        }
        let used: usize = keep.iter().take(3).sum();
        for i in 3..blocks.len() {
            let len = blocks[i].1.len();
            if used + keep[3..i].iter().sum::<usize>() + len <= third {
                keep[i] = len;
            }
        }
    } else {
        let mut used = 0;
        for (i, block) in blocks.iter().enumerate() {
            let len = block.1.len();
            if used + len <= third {
                keep[i] = len;
            } else if i == 0 {
                // The first banner is shown in full unless the pane has no room.
                keep[i] = len.min(usize::from(height.saturating_sub(2)));
            } else {
                break;
            }
            used += keep[i];
        }
    }
    let mut out = BannerRows {
        rows: vec![],
        spans: vec![],
        answers: vec![],
    };
    for (i, (tone, lines)) in blocks.iter_mut().enumerate() {
        if keep[i] == 0 {
            continue;
        }
        let first = out.rows.len();
        if confirming && i == 2 {
            if one_row {
                out.answers
                    .push((Hit::Confirm, first, CONFIRM_AT.0, CONFIRM_AT.1));
                out.answers
                    .push((Hit::Cancel, first, CANCEL_AT.0, CANCEL_AT.1));
            } else {
                out.answers.push((Hit::Confirm, first, 0, CONFIRM_AT.1));
                if keep[i] > 1 {
                    out.answers.push((Hit::Cancel, first + 1, 0, CANCEL_AT.1));
                }
            }
        }
        lines.truncate(keep[i]);
        out.spans.push((i, first, lines.len()));
        out.rows.extend(lines.drain(..).map(|l| (*tone, l)));
    }
    out
}

fn width_of(text: &str) -> usize {
    width(text)
}

/// Where each fixed part of the panel sits in `area`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Regions {
    pub branch: Rect,
    pub banners: Rect,
    pub list: Rect,
    pub commit: Rect,
    pub log: Rect,
}

/// Rows of the commit box that fit: subject, two body rows and the button row; or the
/// subject and the button alone; or none.
fn commit_rows(height: u16) -> u16 {
    match height {
        0..=5 => 0,
        6..=11 => 2,
        _ => 4,
    }
}

pub(crate) fn regions(model: &Changes, area: Rect) -> Regions {
    let height = area.height;
    let branch_h = 1.min(height);
    // A banner never takes more than a third of the panel.
    let banner_h = banner_rows(model, area.width, height).rows.len() as u16;
    // The Review gives the whole list to the diff and the tree: the commit box and the log
    // are the Stage view's.
    let review = model.review_active();
    let mut commit_h = if model.mode == Mode::Changes && !review {
        commit_rows(height)
    } else {
        0
    };
    let mut log_h = if model.mode == Mode::Changes && !review && height >= 20 {
        match &model.log {
            LogState::Idle | LogState::NoCommits => 0,
            LogState::Ready(entries) => (entries.len() as u16 + 1).min(7),
            _ => 2,
        }
    } else {
        0
    };
    // The list keeps at least three rows: the log gives way first, then the commit box.
    let fixed = branch_h + banner_h;
    while height.saturating_sub(fixed + commit_h + log_h) < 3 && (log_h > 0 || commit_h > 0) {
        if log_h > 0 {
            log_h -= 1;
            if log_h == 1 {
                log_h = 0;
            }
        } else {
            commit_h = commit_h.saturating_sub(2);
        }
    }
    let list_h = height.saturating_sub(fixed + commit_h + log_h);
    let mut y = area.y;
    let mut place = |rows: u16| {
        let rect = Rect::new(area.x, y, area.width, rows);
        y += rows;
        rect
    };
    Regions {
        branch: place(branch_h),
        banners: place(banner_h),
        list: place(list_h),
        commit: place(commit_h),
        log: place(log_h),
    }
}

/// The commit box's subject and counter limits, for drawing.
pub(crate) const LIMITS: (usize, usize) = SUBJECT;

/// A control on the branch line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Control {
    /// The branch's name: opens the prompt that switches.
    Branch,
    /// The view switch: the Review and the Stage view.
    ViewReview,
    ViewStage,
    Fetch,
    Push,
}

pub(crate) const TAB_REVIEW: &str = "Review";
pub(crate) const TAB_STAGE: &str = "Stage";
const FETCH_LABEL: &str = "[fetch]";
const PUSH_LABEL: &str = "[push]";

/// The controls on the branch line and where each starts (a column within the line) and
/// its width. Fetch and push show only when the repository has been read, nothing is
/// running and the prompt is closed; a narrow panel shows neither.
pub(crate) fn branch_controls(model: &Changes, line_width: u16) -> Vec<(Control, u16, u16)> {
    let mut out = Vec::new();
    if model.prompt.is_some() || model.snapshot.is_none() {
        return out;
    }
    let label = model.head().map(|h| h.label()).map_or(0, |l| width(&l)) as u16;
    let (fetch, push) = (width(FETCH_LABEL) as u16, width(PUSH_LABEL) as u16);
    let total = fetch + 1 + push;
    let idle = model.in_flight().is_empty();
    let offered = idle && line_width > total + label.min(line_width) + 3;
    // The view switch sits after the branch's name, which gives up room for it (down to twelve
    // cells) before the switch is left out.
    let tail = width(&model.busy_tail()) as u16;
    let tabs = (width(TAB_REVIEW) + 2 + width(TAB_STAGE)) as u16;
    let reserve =
        tabs + 2 + if offered { total + 1 } else { 0 } + if tail > 0 { tail + 2 } else { 0 };
    let room = line_width.saturating_sub(reserve);
    let with_tabs = room >= label.min(12);
    let branch_w = if with_tabs {
        label.min(room)
    } else {
        label.min(line_width)
    };
    out.push((Control::Branch, 0, branch_w));
    if with_tabs {
        let review = width(TAB_REVIEW) as u16;
        out.push((Control::ViewReview, branch_w + 2, review));
        out.push((
            Control::ViewStage,
            branch_w + 2 + review + 2,
            width(TAB_STAGE) as u16,
        ));
    }
    if offered {
        let at = line_width - total;
        out.push((Control::Fetch, at, fetch));
        out.push((Control::Push, at + fetch + 1, push));
    }
    out
}

pub(crate) fn control_label(control: Control) -> &'static str {
    match control {
        Control::Branch => "",
        Control::ViewReview => TAB_REVIEW,
        Control::ViewStage => TAB_STAGE,
        Control::Fetch => FETCH_LABEL,
        Control::Push => PUSH_LABEL,
    }
}

/// What a click on a word of a row's hint asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Verb {
    Diff,
    Stage,
    Unstage,
    Discard,
}

/// The words a cursor row offers, in order (the hint drawn at its right).
pub(crate) fn verbs(section: Section) -> &'static [(&'static str, Verb)] {
    match section {
        Section::Staged => &[("diff", Verb::Diff), ("unstage", Verb::Unstage)],
        Section::Unstaged | Section::Untracked => &[
            ("diff", Verb::Diff),
            ("stage", Verb::Stage),
            ("discard", Verb::Discard),
        ],
        Section::Conflicted => &[("diff", Verb::Diff)],
        Section::Unclassified => &[],
    }
}

/// What lies under a cell of the panel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Hit {
    Nothing,
    Control(Control),
    Banner(usize),
    /// The confirmation's two answers.
    Confirm,
    Cancel,
    /// A section heading; `all` is on its "stage all" or "unstage all".
    Header {
        section: Section,
        all: bool,
    },
    /// A file row; `caret` is on its expand mark, `verb` on a word of its hint.
    File {
        key: RowKey,
        caret: bool,
        verb: Option<Verb>,
    },
    /// A hunk's header or one of its lines.
    Hunk {
        key: RowKey,
        index: usize,
        header: bool,
    },
    Subject,
    Body(usize),
    Button,
    /// The amend box beside the commit button.
    Amend,
    Log(usize),
    /// A commit of an open history.
    Commit(usize),
    /// A branch the prompt offers.
    Branch(usize),
    /// Something in the Review view's list region.
    Review(crate::review_view::ReviewHit),
}

impl Changes {
    /// What is under column `x`, row `y` of the panel drawn into `area` (the point is
    /// relative to the area's corner).
    pub(crate) fn hit(&self, area: Rect, x: u16, y: u16) -> Hit {
        let regions = regions(self, area);
        let (x, y) = (x + area.x, y + area.y);
        let inside = |r: Rect| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
        if inside(regions.branch) {
            let col = x - regions.branch.x;
            return branch_controls(self, regions.branch.width)
                .into_iter()
                .find(|(_, at, w)| col >= *at && col < at + w)
                .map_or(Hit::Nothing, |(control, ..)| Hit::Control(control));
        }
        if inside(regions.banners) {
            let line = (y - regions.banners.y) as usize;
            let laid = banner_rows(self, regions.banners.width, area.height);
            let col = x - regions.banners.x;
            if let Some((hit, ..)) = laid
                .answers
                .iter()
                .find(|(_, row, at, w)| *row == line && col >= *at && col < at + w)
            {
                return hit.clone();
            }
            let banner = laid
                .spans
                .iter()
                .find(|(_, first, rows)| line >= *first && line < first + rows)
                .map_or(0, |(i, ..)| *i);
            return Hit::Banner(banner);
        }
        if inside(regions.list) && self.review_active() {
            return Hit::Review(self.review_hit(area, x, y));
        }
        if inside(regions.list) {
            return self.hit_list(
                regions.list,
                x - regions.list.x,
                (y - regions.list.y) as usize,
            );
        }
        if inside(regions.commit) {
            let r = regions.commit;
            let at = y - r.y;
            if at == 0 {
                return Hit::Subject;
            }
            if at == r.height - 1 {
                let (label, _) = self.commit_button();
                let label_w = width(&format!("[ {label} ]")) as u16;
                let amend_w = width(&self.amend_text()) as u16;
                let room = r.width.saturating_sub(amend_w + 3);
                let shown = label_w.min(room);
                let start = r.width.saturating_sub(shown);
                return if shown > 0 && x - r.x >= start {
                    Hit::Button
                } else if (1..1 + amend_w).contains(&(x - r.x)) {
                    Hit::Amend
                } else {
                    Hit::Nothing
                };
            }
            return Hit::Body(at as usize - 1);
        }
        if inside(regions.log) {
            let at = (y - regions.log.y) as usize;
            if at >= 1 {
                return Hit::Log(at - 1);
            }
        }
        Hit::Nothing
    }

    fn hit_list(&self, list: Rect, x: u16, row: usize) -> Hit {
        let all = rows(self, self.split_at(list.width), list.width);
        let first = self
            .scroll()
            .min(all.len().saturating_sub(list.height as usize));
        let index = first + row;
        let Some(found) = all.get(index) else {
            return Hit::Nothing;
        };
        // The file and hunk a row belongs to are the last ones above it.
        let mut file: Option<&RowKey> = None;
        let mut hunk = 0usize;
        let mut seen_hunk = false;
        for above in all.iter().take(index + 1) {
            match above {
                Row::File { key, .. } => {
                    file = Some(key);
                    hunk = 0;
                    seen_hunk = false;
                }
                Row::Hunk { .. } => {
                    if seen_hunk {
                        hunk += 1;
                    }
                    seen_hunk = true;
                }
                _ => {}
            }
        }
        let w = list.width as usize;
        match found {
            Row::Header { section, count } => {
                let title = format!("{} {count}", section.title());
                let hint = match section {
                    Section::Staged => "unstage all",
                    Section::Unstaged => "stage all",
                    _ => "",
                };
                let hw = width(hint);
                Hit::Header {
                    section: *section,
                    all: hw > 0 && w > width(&title) + hw + 4 && x as usize >= w - hw,
                }
            }
            Row::File { key, .. } => {
                let cursor = self.cursor.as_ref() == Some(key);
                let hint = verbs(key.section)
                    .iter()
                    .map(|(w, _)| *w)
                    .collect::<Vec<_>>()
                    .join("  ");
                let hint_w = width(&hint);
                let room = w.saturating_sub(6);
                let verb = if cursor && hint_w > 0 && room > hint_w + 12 {
                    let start = w - hint_w;
                    let mut at = start;
                    let mut found = None;
                    for (word, verb) in verbs(key.section) {
                        let end = at + width(word);
                        if (x as usize) >= at && (x as usize) < end {
                            found = Some(*verb);
                        }
                        at = end + 2;
                    }
                    found
                } else {
                    None
                };
                Hit::File {
                    key: key.clone(),
                    caret: (1..=2).contains(&x),
                    verb,
                }
            }
            Row::Hunk { .. } | Row::Line { .. } | Row::Pair { .. } => match file {
                Some(key) => Hit::Hunk {
                    key: key.clone(),
                    index: hunk,
                    header: matches!(found, Row::Hunk { .. }),
                },
                None => Hit::Nothing,
            },
            Row::Branch { .. } => Hit::Branch(
                all.iter()
                    .take(index)
                    .filter(|r| matches!(r, Row::Branch { .. }))
                    .count(),
            ),
            // The commits are the last rows of a history; the heading above them wraps.
            Row::Text { .. } if self.mode == Mode::Read => {
                match self.read.as_ref().map(|r| &r.body) {
                    Some(ReadBody::History(c)) if index + c.len() >= all.len() => {
                        Hit::Commit(index + c.len() - all.len())
                    }
                    _ => Hit::Nothing,
                }
            }
            _ => Hit::Nothing,
        }
    }
}
