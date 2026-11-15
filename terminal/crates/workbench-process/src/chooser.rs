//! The first thing Shell shows: what the pane could bind to, with nothing
//! started. Each row says workspace, host, profile and what persistence means
//! for it.

use theorem_workbench_core::host::TerminalAdoption;
use theorem_workbench_core::ids::WorkspaceIdentity;

use crate::catalog::{
    CatalogData, ProcessProfile, ProcessSession, SessionState, backend_word, persistence,
};

#[derive(Clone, Debug)]
pub(crate) enum RowKind {
    Session(Box<ProcessSession>),
    Profile(ProcessProfile),
}

#[derive(Clone, Debug)]
pub(crate) struct Row {
    pub kind: RowKind,
    pub enabled: bool,
    pub reason: Option<String>,
    /// Name, then state.
    pub title: String,
    /// Workspace, host, backend and persistence.
    pub detail: String,
}

pub(crate) fn host_of(identity: &WorkspaceIdentity, session: Option<&ProcessSession>) -> String {
    session
        .and_then(|s| s.host.clone())
        .or_else(|| identity.environment.clone())
        .unwrap_or_else(|| "this host".to_owned())
}

pub(crate) fn rows(data: &CatalogData, identity: &WorkspaceIdentity) -> Vec<Row> {
    let named = identity.is_set();
    let mut out = vec![];
    for s in data
        .sessions
        .iter()
        .filter(|s| s.workspace == identity.workspace)
    {
        let state = match s.state {
            SessionState::Running => "running",
            SessionState::Exited => "exited",
            SessionState::Lost => "lost",
        };
        let mut title = format!("{}  {}  {state}", s.session, s.profile);
        if let Some(program) = s.program {
            title.push_str(&format!("  program {program}"));
        }
        if s.controlled_elsewhere {
            title.push_str("  held by another viewer");
        }
        let mut detail = format!(
            "{} @ {} | {} | {}",
            s.workspace,
            host_of(identity, Some(s)),
            backend_word(s.backend),
            persistence(s.backend)
        );
        // The program's own word, for a program that is running, behind the
        // same provenance wording the pane uses.
        if s.state == SessionState::Running
            && let Some(report) = crate::report::compact(&s.program_report)
        {
            detail.push_str(" | ");
            detail.push_str(&report);
        }
        // A lost session is a lost connection: the program may still run.
        if s.state == SessionState::Lost {
            detail.push_str(" | connection lost");
            if let Some(reason) = &s.reason {
                detail.push_str(": ");
                detail.push_str(reason);
            }
            match s.next_step.as_deref() {
                Some("retry") => detail.push_str(". Attach to retry"),
                Some(other) => {
                    detail.push_str(". Host next step: ");
                    detail.push_str(other);
                }
                None => {}
            }
        }
        out.push(Row {
            enabled: named,
            reason: (!named).then(|| "The host has not named a workspace yet.".to_owned()),
            detail,
            title,
            kind: RowKind::Session(Box::new(s.clone())),
        });
    }
    for p in &data.profiles {
        let (enabled, reason) =
            if !named {
                (
                    false,
                    Some("The host has not named a workspace yet.".to_owned()),
                )
            } else if !p.available {
                (
                    false,
                    Some(p.unavailable_reason.clone().unwrap_or_else(|| {
                        "The host reports this backend unavailable.".to_owned()
                    })),
                )
            } else {
                (true, None)
            };
        let mut detail = format!(
            "{} @ {} | {} | {}",
            identity.workspace,
            host_of(identity, None),
            backend_word(p.backend),
            persistence(p.backend)
        );
        if let Some(reason) = reason.as_deref().filter(|_| named) {
            detail = format!("unavailable: {reason}");
        }
        out.push(Row {
            title: format!("Start {}", p.label),
            kind: RowKind::Profile(p.clone()),
            enabled,
            reason,
            detail,
        });
    }
    out
}

pub(crate) fn session_count(rows: &[Row]) -> usize {
    rows.iter()
        .filter(|r| matches!(r.kind, RowKind::Session(_)))
        .count()
}

/// One drawn line of the chooser.
pub(crate) struct Line {
    pub text: String,
    pub kind: LineKind,
    pub row: Option<usize>,
    /// A wrapped continuation of the line above it, not a line of its own.
    pub cont: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum LineKind {
    Heading,
    Body,
    Muted,
    Row,
    RowDetail,
    Note,
}

pub(crate) fn lines(
    rows: &[Row],
    identity: &WorkspaceIdentity,
    adoption: Option<&TerminalAdoption>,
    note: Option<&str>,
    width: u16,
) -> Vec<Line> {
    let mut out = vec![];
    // Rows are drawn behind a two-cell marker; everything wraps to what is left.
    let mut push = |text: String, kind, row| {
        let room = if matches!(kind, LineKind::Row | LineKind::RowDetail) {
            width.saturating_sub(2).max(1)
        } else {
            width
        };
        let wrapped = if width == 0 {
            vec![text]
        } else {
            crate::wrap::wrap(&text, room)
        };
        for (i, text) in wrapped.into_iter().enumerate() {
            out.push(Line {
                text,
                kind,
                row,
                cont: i > 0,
            });
        }
    };
    let host = host_of(identity, None);
    if identity.is_set() {
        push(
            format!("Shell on {host} | workspace {}", identity.workspace),
            LineKind::Heading,
            None,
        );
    } else {
        push(
            "Shell | waiting for the host to name a workspace".to_owned(),
            LineKind::Heading,
            None,
        );
    }
    push(
        "Nothing starts until you choose a row. Enter chooses.".to_owned(),
        LineKind::Muted,
        None,
    );
    if let Some(note) = note {
        push(note.to_owned(), LineKind::Note, None);
    }
    let sessions = session_count(rows);
    match adoption {
        Some(TerminalAdoption::Pending) => push(
            "The host is still looking for running terminals. This list may be incomplete."
                .to_owned(),
            LineKind::Note,
            None,
        ),
        Some(TerminalAdoption::Unavailable { reason, next_step }) => push(
            format!(
                "{}{}",
                match reason {
                    Some(r) => format!("The host cannot list its terminals: {r}"),
                    None => "The host cannot list its terminals.".to_owned(),
                },
                match next_step.as_deref() {
                    Some("retry") => " Retry to list them again.".to_owned(),
                    Some(other) => format!(" The host's next step: {other}."),
                    None => String::new(),
                }
            ),
            LineKind::Note,
            None,
        ),
        Some(TerminalAdoption::Settled) | None => {}
    }
    push(String::new(), LineKind::Body, None);
    // An empty list is only "no terminals" when nothing says it is incomplete.
    let incomplete = matches!(
        adoption,
        Some(TerminalAdoption::Pending | TerminalAdoption::Unavailable { .. })
    );
    push(
        if sessions == 0 && incomplete {
            "No sessions listed yet".to_owned()
        } else if sessions == 0 {
            "No existing sessions to attach to".to_owned()
        } else {
            "Existing sessions (attach; o observes, t takes control)".to_owned()
        },
        LineKind::Heading,
        None,
    );
    for (i, row) in rows.iter().enumerate() {
        if i == sessions {
            push(String::new(), LineKind::Body, None);
            push("Start a new process".to_owned(), LineKind::Heading, None);
        }
        push(row.title.clone(), LineKind::Row, Some(i));
        push(row.detail.clone(), LineKind::RowDetail, Some(i));
    }
    if rows.len() == sessions {
        push(String::new(), LineKind::Body, None);
        push("Start a new process".to_owned(), LineKind::Heading, None);
        push(
            "No profile is offered by this host.".to_owned(),
            LineKind::Muted,
            None,
        );
    }
    out
}

/// The first line to draw so the selected row's lines are visible.
///
/// A row wrapped taller than the pane keeps its first line on screen: the
/// title is what names it.
pub(crate) fn top_for(lines: &[Line], selected: usize, height: usize) -> usize {
    let last = lines
        .iter()
        .rposition(|l| l.row == Some(selected))
        .unwrap_or(0);
    let first = lines
        .iter()
        .position(|l| l.row == Some(selected))
        .unwrap_or(0);
    (last + 1).saturating_sub(height).min(first)
}
