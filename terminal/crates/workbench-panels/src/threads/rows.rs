//! The rows of the Threads panel, built from the last listing and the last
//! terminal sessions. Rows are rebuilt on demand: the panel keeps only the
//! listing, the sessions and which rows are open.

use std::collections::BTreeSet;

use theorem_workbench_core::host::{ProgramReport, ProgramState, TerminalSessionInfo};
use theorem_workbench_core::threads::{ThreadItem, ThreadListing};

/// What a row is, with what drawing and acting on it need. Every key is unique
/// among the rows, so a thread shown under two projects has two rows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Row {
    /// A small dim section label: Pinned, Projects, Herdr.
    Label {
        id: &'static str,
        text: &'static str,
    },
    /// A machine of the Herdr section.
    Group {
        id: String,
        text: String,
    },
    Project {
        key: String,
        id: String,
        name: String,
        open: bool,
        pos: usize,
        set: usize,
    },
    Thread {
        key: String,
        /// Index into the listing's threads.
        idx: usize,
        /// The project the row sits under, or the one a pinned row opens in.
        project: String,
        depth: usize,
        /// `None` when the thread has nothing under it.
        open: Option<bool>,
        /// A pinned row names its project on a dim second line.
        second: Option<String>,
        pos: usize,
        set: usize,
    },
    Delegation {
        key: String,
        idx: usize,
        project: String,
        label: String,
        /// The delegation and the run that holds it: what its changes panel
        /// is opened with.
        delegation: String,
        run: String,
        depth: usize,
        pos: usize,
        set: usize,
    },
    Session {
        key: String,
        /// Index into the sessions.
        idx: usize,
        depth: usize,
        pos: usize,
        set: usize,
    },
    Status {
        id: String,
        text: String,
    },
    Confirm {
        text: String,
    },
    Edit {
        depth: usize,
    },
}

impl Row {
    /// The key of a row the cursor can stand on.
    pub(super) fn key(&self) -> Option<&str> {
        match self {
            Self::Project { key, .. }
            | Self::Thread { key, .. }
            | Self::Delegation { key, .. }
            | Self::Session { key, .. } => Some(key),
            _ => None,
        }
    }

    pub(super) fn height(&self) -> usize {
        match self {
            Self::Thread {
                second: Some(_), ..
            } => 2,
            _ => 1,
        }
    }

    pub(super) fn depth(&self) -> usize {
        match self {
            Self::Thread { depth, .. }
            | Self::Delegation { depth, .. }
            | Self::Session { depth, .. }
            | Self::Edit { depth } => *depth,
            _ => 0,
        }
    }
}

/// Newest activity first.
fn activity(t: &ThreadItem) -> i64 {
    t.last_message_ms.or(t.created_ms).unwrap_or(0)
}

fn newest_first(threads: &[ThreadItem], a: usize, b: usize) -> std::cmp::Ordering {
    activity(&threads[b])
        .cmp(&activity(&threads[a]))
        .then_with(|| threads[a].id.cmp(&threads[b].id))
}

/// Whether following `origin` from `start` comes back to it: such threads
/// would each be the other's child and neither would show.
fn cycles(threads: &[ThreadItem], start: usize) -> bool {
    let mut at = start;
    for _ in 0..threads.len() {
        let Some(parent) = threads[at]
            .origin
            .as_deref()
            .and_then(|o| threads.iter().position(|t| t.id == o))
        else {
            return false;
        };
        if parent == start {
            return true;
        }
        at = parent;
    }
    true
}

pub(super) struct Open<'a> {
    /// Keys whose open state differs from the default (projects open, threads closed).
    pub toggled: &'a BTreeSet<String>,
    pub archived: bool,
}

impl Open<'_> {
    pub(super) fn is_open(&self, key: &str, default: bool) -> bool {
        default ^ self.toggled.contains(key)
    }
}

pub(super) fn project_key(id: &str) -> String {
    format!("p:{id}")
}

pub(super) fn thread_key(project: &str, id: &str) -> String {
    format!("t:{project}:{id}")
}

/// The pinned section, the projects with their threads, children and
/// delegations, in the order they are drawn.
pub(super) fn threads(listing: &ThreadListing, open: &Open) -> Vec<Row> {
    let mut rows = vec![];
    let t = &listing.threads;
    let shown = |i: usize| open.archived || !t[i].archived;

    let mut pinned: Vec<usize> = (0..t.len()).filter(|&i| t[i].pinned && shown(i)).collect();
    pinned.sort_by(|&a, &b| newest_first(t, a, b));
    if !pinned.is_empty() {
        rows.push(Row::Label {
            id: "pinned",
            text: "Pinned",
        });
        let set = pinned.len();
        for (n, &i) in pinned.iter().enumerate() {
            let project = home(listing, i);
            let name = listing
                .projects
                .iter()
                .find(|p| p.id == project)
                .map_or_else(String::new, |p| p.name.clone());
            rows.push(Row::Thread {
                key: format!("pin:{}", t[i].id),
                idx: i,
                project,
                depth: 0,
                open: None,
                second: Some(name),
                pos: n + 1,
                set,
            });
        }
    }

    rows.push(Row::Label {
        id: "projects",
        text: "Projects",
    });
    if listing.projects.is_empty() {
        rows.push(Row::Status {
            id: "no-projects".into(),
            text: "No projects".into(),
        });
    }
    let set = listing.projects.len();
    for (n, p) in listing.projects.iter().enumerate() {
        let key = project_key(&p.id);
        let is_open = open.is_open(&key, true);
        rows.push(Row::Project {
            key,
            id: p.id.clone(),
            name: p.name.clone(),
            open: is_open,
            pos: n + 1,
            set,
        });
        if !is_open {
            continue;
        }
        // Pinned threads are in the pinned section only.
        let here: Vec<usize> = (0..t.len())
            .filter(|&i| t[i].project_ids.contains(&p.id) && shown(i) && !t[i].pinned)
            .collect();
        let has_parent = |i: usize| {
            !cycles(t, i)
                && t[i]
                    .origin
                    .as_deref()
                    .is_some_and(|o| here.iter().any(|&j| t[j].id == o && j != i))
        };
        let mut top: Vec<usize> = here.iter().copied().filter(|&i| !has_parent(i)).collect();
        top.sort_by(|&a, &b| newest_first(t, a, b));
        let set = top.len();
        let mut seen = BTreeSet::new();
        for (n, &i) in top.iter().enumerate() {
            thread_rows(
                listing,
                open,
                &here,
                &p.id,
                i,
                1,
                (n + 1, set),
                &mut seen,
                &mut rows,
            );
        }
    }
    rows
}

/// The project a thread opens in: the open conversation's when it is there,
/// else its first.
fn home(listing: &ThreadListing, i: usize) -> String {
    let t = &listing.threads[i];
    listing
        .open
        .as_ref()
        .filter(|o| o.thread_id == t.id && t.project_ids.contains(&o.project_id))
        .map(|o| o.project_id.clone())
        .or_else(|| t.project_ids.first().cloned())
        .unwrap_or_default()
}

#[allow(clippy::too_many_arguments)]
fn thread_rows(
    listing: &ThreadListing,
    open: &Open,
    here: &[usize],
    project: &str,
    i: usize,
    depth: usize,
    (pos, set): (usize, usize),
    seen: &mut BTreeSet<usize>,
    rows: &mut Vec<Row>,
) {
    if !seen.insert(i) {
        return;
    }
    let t = &listing.threads;
    let mut kids: Vec<usize> = here
        .iter()
        .copied()
        .filter(|&j| j != i && t[j].origin.as_deref() == Some(t[i].id.as_str()) && !cycles(t, j))
        .collect();
    kids.sort_by(|&a, &b| newest_first(t, a, b));
    let delegations = &t[i].delegations;
    let below = kids.len() + delegations.len();
    let key = thread_key(project, &t[i].id);
    let is_open = open.is_open(&key, false);
    rows.push(Row::Thread {
        key: key.clone(),
        idx: i,
        project: project.to_owned(),
        depth,
        open: (below > 0).then_some(is_open),
        second: None,
        pos,
        set,
    });
    if below == 0 || !is_open {
        return;
    }
    for (n, &j) in kids.iter().enumerate() {
        thread_rows(
            listing,
            open,
            here,
            project,
            j,
            depth + 1,
            (n + 1, below),
            seen,
            rows,
        );
    }
    for (n, d) in delegations.iter().enumerate() {
        rows.push(Row::Delegation {
            key: format!("d:{project}:{}:{}", t[i].id, d.id),
            idx: i,
            project: project.to_owned(),
            label: d.label.clone(),
            delegation: d.id.clone(),
            run: d.run_id.clone(),
            depth: depth + 1,
            pos: kids.len() + n + 1,
            set: below,
        });
    }
}

/// The word the program itself reported, never inferred from anything else.
pub(super) fn program_word(session: &TerminalSessionInfo) -> Option<String> {
    match &session.program_report {
        ProgramReport::Current { status, .. } => Some(match status.state {
            ProgramState::Idle => "idle".to_owned(),
            ProgramState::Working => "working".to_owned(),
            ProgramState::Done => "done".to_owned(),
            ProgramState::Blocked => "blocked".to_owned(),
            ProgramState::Error => "error".to_owned(),
            ProgramState::Unknown => status.raw_state.clone().unwrap_or_default(),
        })
        .filter(|w| !w.is_empty()),
        _ => None,
    }
}

/// The last two parts of a working directory.
pub(super) fn cwd_tail(cwd: &str) -> String {
    let parts: Vec<&str> = cwd.split('/').filter(|p| !p.is_empty()).collect();
    match parts.len() {
        0 => cwd.to_owned(),
        1 => parts[0].to_owned(),
        n => format!("{}/{}", parts[n - 2], parts[n - 1]),
    }
}

/// What a session row calls the session: its own name, else its profile.
pub(super) fn session_name(session: &TerminalSessionInfo) -> &str {
    session
        .name
        .as_deref()
        .filter(|n| !n.is_empty())
        .unwrap_or(&session.profile)
}

pub(super) fn session_key(session: &TerminalSessionInfo) -> String {
    format!("s:{}", session.session)
}

/// The Herdr section: its sessions, by machine when a session names one.
pub(super) fn herdr(sessions: &[TerminalSessionInfo]) -> Vec<Row> {
    let mut rows = vec![Row::Label {
        id: "herdr",
        text: "Herdr",
    }];
    if sessions.is_empty() {
        rows.push(Row::Status {
            id: "no-sessions".into(),
            text: "No Herdr sessions".into(),
        });
        return rows;
    }
    let grouped = sessions.iter().any(|s| s.host.is_some());
    let mut hosts: Vec<Option<&str>> = sessions.iter().map(|s| s.host.as_deref()).collect();
    hosts.sort();
    hosts.dedup();
    if !grouped {
        hosts = vec![None];
    }
    for host in hosts {
        let mut here: Vec<usize> = (0..sessions.len())
            .filter(|&i| !grouped || sessions[i].host.as_deref() == host)
            .collect();
        here.sort_by(|&a, &b| {
            session_name(&sessions[a])
                .cmp(session_name(&sessions[b]))
                .then_with(|| sessions[a].session.cmp(&sessions[b].session))
        });
        if grouped {
            rows.push(Row::Group {
                id: format!("host:{}", host.unwrap_or("")),
                text: host.unwrap_or("This machine").to_owned(),
            });
        }
        let set = here.len();
        for (n, &i) in here.iter().enumerate() {
            rows.push(Row::Session {
                key: session_key(&sessions[i]),
                idx: i,
                depth: usize::from(grouped),
                pos: n + 1,
                set,
            });
        }
    }
    rows
}
