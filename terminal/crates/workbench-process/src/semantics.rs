//! What the accessible tree and `workbench.read` see. It carries host fields,
//! the pane's own state words and the screen as text (spelled out by
//! `visible`, since the screen is the program's and untrusted).
//!
//! A terminal is not a text field: the program owns the line being edited, so
//! the terminal node publishes `text` and no `selection`. A caret offset would
//! point into a screen the program redraws on every keystroke, and a screen
//! reader that took it for an editable field would type into the wrong place.
//! The cursor cell is in the node's description, which is what a reader needs.

use ratatui::layout::Rect;
use theorem_workbench_core::ViewCtx;
use theorem_workbench_core::ids::ResourceRef;
use theorem_workbench_core::semantics::{Node, NodeAction, NodeId, Role as Aria};

use crate::bound::{Bound, EndAsk, Role, Status, Tone};
use crate::chooser::{self, RowKind};
use crate::draw;
use crate::panel::ProcessPanel;
use crate::report;
use crate::state::{Stage, reason_text};
use theorem_workbench_text::visible::visible;

fn action(id: &str, enabled: bool, reason: Option<String>) -> NodeAction {
    NodeAction {
        id: id.into(),
        enabled,
        reason: if enabled { None } else { reason },
        title: None,
    }
}

fn ids(nodes: &[Node]) -> Vec<NodeId> {
    nodes.iter().map(|n| n.id.clone()).collect()
}

pub(crate) fn nodes(p: &ProcessPanel, area: Rect, cx: &ViewCtx) -> Vec<Node> {
    let mut root = Node::new("shell", Aria::Region, "Shell", area);
    root.binding = p.resource();
    root.state.focused = cx.focused;
    let children = match &p.stage {
        Stage::Choosing => choosing(p, area),
        Stage::Restoring(saved) => {
            let mut status = Node::new(
                "status",
                Aria::Status,
                &format!("Re-attaching to {} by identity", saved.session),
                area,
            );
            status.state.busy = true;
            status.state.description =
                Some("Nothing is relaunched; the pane attaches to the saved terminal.".into());
            vec![status]
        }
        Stage::Opening(op) => {
            let mut status = Node::new(
                "status",
                if op.uncertain.is_some() {
                    Aria::Alert
                } else {
                    Aria::Status
                },
                &match &op.uncertain {
                    Some(_) => format!("Unknown whether {} started", op.choice.label),
                    None => format!("Starting {}", op.choice.label),
                },
                area,
            );
            status.state.busy = op.uncertain.is_none();
            status.state.description = op.uncertain.as_deref().map(|r| reason_text(r).to_owned());
            vec![status]
        }
        Stage::Failed(failure) => {
            let mut alert = Node::new("status", Aria::Alert, draw::failure_title(failure), area);
            alert.state.description = Some(reason_text(&failure.reason).to_owned());
            let mut retry = Node::new("retry", Aria::Button, "Try again", area);
            retry.actions = vec![action("shell.start", true, None)];
            vec![alert, retry]
        }
        Stage::Bound(b) => live(b, area, cx),
    };
    // A node has one parent: whatever another node owns is not the root's.
    let owned: Vec<NodeId> = children
        .iter()
        .flat_map(|n| n.children.iter().cloned())
        .collect();
    root.children = children
        .iter()
        .map(|n| n.id.clone())
        .filter(|id| !owned.contains(id))
        .collect();
    let mut out = vec![root];
    out.extend(children);
    out
}

fn choosing(p: &ProcessPanel, area: Rect) -> Vec<Node> {
    let rows = chooser::rows(&p.catalog.snapshot(&p.identity.workspace), &p.identity);
    let mut status = Node::new(
        "status",
        Aria::Status,
        if p.identity.is_set() {
            "Choose a session or a profile. Nothing has started."
        } else {
            "Waiting for the host to name a workspace."
        },
        Rect::new(area.x, area.y, area.width, 1),
    );
    status.state.description = p.note.clone();
    let mut menu = Node::new("chooser", Aria::Menu, "Shell sessions and profiles", area);
    menu.binding = ResourceRef::Workspace {
        workspace: p.identity.workspace.clone(),
    };
    let total = u16::try_from(rows.len()).unwrap_or(u16::MAX);
    let selected = p.selected.min(rows.len().saturating_sub(1));
    // Where each row is drawn: the lines it wraps to, as the draw scrolls them. A row scrolled
    // out of the pane is not drawn and has no height.
    let data = p.catalog.snapshot(&p.identity.workspace);
    let lines = chooser::lines(
        &rows,
        &p.identity,
        data.adoption.as_ref(),
        p.note.as_deref(),
        area.width,
    );
    let top = chooser::top_for(&lines, selected, usize::from(area.height));
    let shown = top..top + usize::from(area.height);
    let mut items = vec![];
    for (i, row) in rows.iter().enumerate() {
        let drawn: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter(|(at, l)| l.row == Some(i) && shown.contains(at))
            .map(|(at, _)| at)
            .collect();
        let rect = match (drawn.first(), drawn.last()) {
            (Some(first), Some(last)) => Rect::new(
                area.x,
                area.y + u16::try_from(first - top).unwrap_or(u16::MAX),
                area.width,
                u16::try_from(last - first + 1).unwrap_or(u16::MAX),
            ),
            _ => Rect::new(area.x, area.y, area.width, 0),
        };
        let mut item = Node::new(
            &format!("row:{i}"),
            Aria::MenuItem,
            &format!("{}. {}", row.title, row.detail),
            rect,
        );
        item.pos_in_set = Some(u16::try_from(i + 1).unwrap_or(u16::MAX));
        item.set_size = Some(total);
        item.state.selected = i == selected;
        item.state.disabled = !row.enabled;
        item.state.description = row.reason.clone();
        item.actions = match &row.kind {
            RowKind::Session(_) => vec![action("shell.attach", row.enabled, row.reason.clone())],
            RowKind::Profile(_) => vec![action("shell.start", row.enabled, row.reason.clone())],
        };
        items.push(item);
    }
    menu.children = ids(&items);
    let mut out = vec![status, menu];
    out.extend(items);
    out
}

/// The most screen rows the terminal node's text carries, from the bottom.
pub(crate) const SCREEN_ROWS: usize = 60;

/// The process's state in words, first in the terminal node's description:
/// whether a coding agent there is still running.
fn process_words(b: &Bound) -> String {
    match &b.status {
        Status::Running if b.attaching() => "Attaching to the terminal.".to_owned(),
        Status::Running => "The program is running.".to_owned(),
        Status::Exited {
            code: Some(code), ..
        } => format!("The program exited with code {code}."),
        Status::Exited { reason, .. } if !reason.is_empty() => {
            format!("The program ended: {}.", visible(reason))
        }
        Status::Exited { .. } => "The program ended.".to_owned(),
        Status::Lost { link: true, .. } => {
            "The connection to the terminal is lost; the program may still run.".to_owned()
        }
        Status::Lost { .. } => "The program's fate is not known.".to_owned(),
    }
}

/// Why a pane that is not running cannot act: a lost connection is not an
/// ended program.
fn not_running(b: &Bound) -> &'static str {
    if matches!(b.status, Status::Lost { link: true, .. }) {
        "The connection to the terminal is lost."
    } else {
        "The program is not running."
    }
}

fn live(b: &Bound, area: Rect, cx: &ViewCtx) -> Vec<Node> {
    let g = draw::geo(area);
    let mut status = Node::new("status", Aria::Status, &draw::status_line(b), g.header);
    status.state.busy = b.attaching() || b.end == EndAsk::Pending;
    status.state.description = match &b.status {
        Status::Lost {
            reason,
            next_step,
            link: true,
        } => Some(visible(&draw::loss_text(reason, next_step.as_deref()))),
        Status::Exited { reason, .. } | Status::Lost { reason, .. } => Some(visible(reason)),
        Status::Running => b.provenance.text(b.program, b.epoch),
    };
    status.binding = b.resource();

    let mut term = Node::new(
        "terminal",
        Aria::TextBox,
        &format!("Terminal {}", b.session),
        g.term,
    );
    term.binding = b.resource();
    term.state.focused = cx.focused && b.controlling();
    term.state.disabled = !b.controlling() || !b.running();
    // What a person sees, so assistive technology and the agent read the same
    // screen; the node's text follows each frame because the tree is rebuilt
    // from the screen.
    // The last rows only, so a tall window cannot make the node unbounded:
    // what a coding agent printed most recently is at the bottom.
    let screen = b.screen.contents();
    let rows: Vec<&str> = screen.split('\n').collect();
    let from = rows.len().saturating_sub(SCREEN_ROWS);
    term = term.with_text(
        &rows[from..]
            .iter()
            .map(|row| visible(row))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    let (row, col) = b.screen.cursor_position();
    let mut notes = vec![
        process_words(b),
        format!("Cursor at row {}, column {}.", row + 1, col + 1),
    ];
    if !b.screen.cursor_visible() {
        notes.push("The program hid the cursor.".into());
    }
    if b.screen.alternate_screen() {
        notes.push("Alternate screen.".into());
    }
    if b.screen.bracketed_paste() {
        notes.push("Bracketed paste on.".into());
    }
    if let Role::Observer(why) = &b.role
        && b.running()
    {
        notes.insert(0, why.text());
    }
    term.state.description = Some(notes.join(" "));

    let mut out = vec![status, term];

    if let Some((text, tone)) = draw::footer(b) {
        // A question is a dialog. What was refused, failed or is unknown needs attention (an
        // alert); a passing remark is a status.
        let role = if b.end == EndAsk::Asking {
            Aria::Dialog
        } else if matches!(tone, Tone::Muted) {
            Aria::Status
        } else {
            Aria::Alert
        };
        let rect = draw::footer_view(area, b).map_or(g.footer, |f| f.rect);
        out.push(Node::new("notice", role, &visible(&text), rect));
    }

    // The program's own word, a node of its own: named for who is speaking,
    // with the state and text as its description, no action, and no part of
    // its text in any id or action.
    if let Some(description) = report::description(&b.report) {
        let footer_rect = draw::footer_view(area, b).map_or(g.footer, |f| f.rect);
        let head = draw::header_rows(&draw::status_line(b), area, draw::end_button(g.header, b));
        let head_n = u16::try_from(head.len()).unwrap_or(u16::MAX);
        let rect = report::band(area, b, head_n, footer_rect.y).map_or_else(
            || Rect::new(area.x, area.y, area.width, area.height.min(1)),
            |band| band.rect,
        );
        let mut node = Node::new(
            "program-report",
            Aria::Status,
            report::node_name(b.status.program_ended()),
            rect,
        );
        node.state.description = Some(description);
        node.binding = b.resource();
        out.push(node);
    }

    let can_act = b.running() && !b.attaching();
    let mut control = Node::new("request-control", Aria::Button, "Request control", g.footer);
    control.actions = vec![if b.controlling() {
        action(
            "shell.control",
            false,
            Some("This view already controls the terminal.".into()),
        )
    } else if !b.running() {
        action("shell.control", false, Some(not_running(b).into()))
    } else if b.attaching() {
        action("shell.control", false, Some("Still attaching.".into()))
    } else {
        action("shell.control", true, None)
    }];
    let mut end = Node::new("end-process", Aria::Button, "End process", g.header);
    end.actions = vec![if can_act {
        action("shell.end", true, None)
    } else {
        action(
            "shell.end",
            false,
            Some(if b.running() {
                "Still attaching.".to_owned()
            } else {
                not_running(b).to_owned()
            }),
        )
    }];
    end.state.description = Some("Asks first. A person confirms with a key or a click.".into());
    let mut resend = Node::new("resend", Aria::Button, "Resend unconfirmed input", g.footer);
    let unknown = b.unknown_inputs();
    resend.actions = vec![if unknown > 0 && b.gate().is_ok() {
        action("shell.resend", true, None)
    } else {
        action(
            "shell.resend",
            false,
            Some("No unconfirmed input, or this view cannot send.".into()),
        )
    }];
    let mut toolbar = Node::new("actions", Aria::Toolbar, "Shell actions", area);
    let buttons = vec![control, end, resend];
    toolbar.children = ids(&buttons);
    out.push(toolbar);
    out.extend(buttons);

    if matches!(b.status, Status::Lost { link: true, .. }) {
        let mut again = Node::new("reconnect", Aria::Button, "Reconnect", g.footer);
        again.state.description =
            Some("Attaches to the same terminal again. The program may still be running.".into());
        again.actions = vec![action("shell.reconnect", true, None)];
        out.push(again);
    } else if !b.running() {
        let mut fresh = Node::new("start-new", Aria::Button, "Start a new shell", g.footer);
        fresh.state.description =
            Some("A different process. It never continues the one that ended.".into());
        fresh.actions = vec![action(
            "shell.start",
            b.profile.is_some(),
            (b.profile.is_none()).then(|| "Choose a profile from the chooser.".to_owned()),
        )];
        out.push(fresh);
    }
    out
}
