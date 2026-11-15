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
use theorem_workbench_core::completion::BranchInfo;

use crate::diff::{DiffLine, Hunk, pair_places};
use crate::model::{
    BranchList, Changes, DiffLayout, DiffState, LogState, Mode, PanelState, Problem, SUBJECT,
};
use crate::status::{Change, LISTED, RowKey, Section};

/// How a line of text is toned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tone {
    Muted,
    Warning,
    Error,
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
    /// A line of words: a state, a note under a diff, a count.
    Text {
        text: String,
        tone: Tone,
        indent: u16,
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

fn text(text: impl Into<String>, tone: Tone) -> Row<'static> {
    Row::Text {
        text: text.into(),
        tone,
        indent: 0,
    }
}

pub(crate) fn problem_tone(problem: &Problem) -> Tone {
    match problem {
        Problem::Refused { .. } | Problem::Failed { .. } => Tone::Error,
        Problem::Uncertain { .. } => Tone::Warning,
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

/// The rows of the scrolling list. `split` is whether the diffs are drawn side by
/// side at this width.
pub(crate) fn rows(model: &Changes, split: bool) -> Vec<Row<'_>> {
    if model.mode == Mode::Branches {
        return branch_rows(model);
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
                out.push(text(reason, Tone::Muted));
            }
            PanelState::Uncertain { reason } => {
                out.push(text(
                    "Unknown result: the repository was not read.",
                    Tone::Warning,
                ));
                out.push(text(reason, Tone::Muted));
                out.push(text("Refresh to read it again.", Tone::Muted));
            }
            PanelState::Failed { reason } => {
                out.push(text("The repository could not be read.", Tone::Error));
                out.push(text(reason, Tone::Muted));
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

fn branch_rows(model: &Changes) -> Vec<Row<'_>> {
    let mut out = vec![text("Switch branch", Tone::Muted)];
    match &model.branches {
        BranchList::Idle | BranchList::Loading => {
            out.push(text("Reading branches...", Tone::Muted))
        }
        BranchList::Outdated => out.push(text(
            "The branch list was for an earlier state of the repository and was dropped.",
            Tone::Warning,
        )),
        BranchList::Problem(problem) => out.push(text(problem.text(), problem_tone(problem))),
        BranchList::Ready(list) if list.is_empty() => out.push(text("No branches", Tone::Muted)),
        BranchList::Ready(list) => {
            for (at, info) in list.iter().enumerate() {
                out.push(Row::Branch {
                    info,
                    cursor: at == model.branch_cursor,
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
        out.push((
            Tone::Muted,
            "Confirm to go ahead, cancel to leave it.".to_owned(),
        ));
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
    out.truncate(5);
    out
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
    let banner_h = (banners(model).len() as u16).min(height / 3);
    let mut commit_h = if model.mode == Mode::Changes {
        commit_rows(height)
    } else {
        0
    };
    let mut log_h = if model.mode == Mode::Changes && height >= 20 {
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
