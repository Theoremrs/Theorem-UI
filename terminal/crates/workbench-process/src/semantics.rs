//! What the accessible tree and `workbench.read` see. It carries host fields
//! and the pane's own state words; it never carries screen text, which is the
//! program's and has no structure to offer.

use ratatui::layout::Rect;
use theorem_workbench_core::ViewCtx;
use theorem_workbench_core::ids::ResourceRef;
use theorem_workbench_core::semantics::{Node, NodeAction, NodeId, Role as Aria};

use crate::bound::{Bound, EndAsk, Role, Status};
use crate::chooser::{self, RowKind};
use crate::draw;
use crate::panel::ProcessPanel;
use crate::state::{Stage, reason_text};

fn action(id: &str, enabled: bool, reason: Option<String>) -> NodeAction {
    NodeAction {
        id: id.into(),
        enabled,
        reason: if enabled { None } else { reason },
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
                Aria::Status,
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
    let mut items = vec![];
    for (i, row) in rows.iter().enumerate() {
        let mut item = Node::new(
            &format!("row:{i}"),
            Aria::MenuItem,
            &format!("{}. {}", row.title, row.detail),
            Rect::new(area.x, area.y, area.width, 0),
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

fn live(b: &Bound, area: Rect, cx: &ViewCtx) -> Vec<Node> {
    let g = draw::geo(area);
    let mut status = Node::new("status", Aria::Status, &draw::status_line(b), g.header);
    status.state.busy = b.attaching() || b.end == EndAsk::Pending;
    status.state.description = match &b.status {
        Status::Exited { reason, .. } | Status::Lost { reason } => Some(reason.clone()),
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
    term = term.with_text(&b.screen.contents());
    let (row, col) = b.screen.cursor_position();
    let mut notes = vec![format!("Cursor at row {}, column {}.", row + 1, col + 1)];
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

    if let Some((text, _)) = draw::footer(b) {
        let role = if b.end == EndAsk::Asking {
            Aria::Dialog
        } else {
            Aria::Alert
        };
        out.push(Node::new("notice", role, &text, g.footer));
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
        action(
            "shell.control",
            false,
            Some("The program is not running.".into()),
        )
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
                "The program is not running.".to_owned()
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

    if !b.running() {
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
