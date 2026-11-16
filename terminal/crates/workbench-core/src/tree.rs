//! `semantics`: one tree for the whole workbench, composed from the dock and
//! each panel's own nodes (ARCHITECTURE section 8). The human, assistive and
//! agent views read the same tree.

use ratatui::layout::Rect;
use theorem_workbench_dock::{GroupFrame, GroupId, Role as DockRole, SolvedFrame, Suppressed};

use crate::caret::escaped;
use crate::ids::{ActionId, PanelInstanceId, ResourceRef};
use crate::model::Model;
use crate::panel::ViewCtx;
use crate::panels::{ACTION_TAB_CLOSE, ACTION_TAB_FOCUS};
use crate::registry::Availability;
use crate::semantics::{Node, NodeAction, NodeId, Role, SemanticTree};
use crate::theme::Theme;
use theorem_workbench_text::visible::visible;

const ROOT: &str = "workbench";

pub fn semantics(model: &Model) -> SemanticTree {
    let Some(vp) = model.viewport() else {
        return SemanticTree {
            root: NodeId::new(ROOT),
            nodes: vec![Node::new(
                ROOT,
                Role::Application,
                "Workbench",
                Rect::default(),
            )],
        };
    };
    let solved;
    let frame = match model.frame() {
        Some(f) => f,
        None => {
            solved = model.dock().solve(model.dock_area_in(vp.area), vp.metrics);
            &solved
        }
    };
    let picker = model.picker_view();
    let theme = Theme::plain();
    let window = model.focus().window;

    let mut root = Node::new(ROOT, Role::Application, "Workbench", frame.area);
    let mut nodes = vec![];
    for group in &frame.groups {
        let cx = ViewCtx {
            theme: &theme,
            workspace: model.workspace(),
            focused: group.focused && window,
            picker: picker.as_ref(),
            capabilities: model.capabilities(),
        };
        root.children
            .push(group_nodes(model, group, &cx, &mut nodes));
    }
    for splitter in &frame.splitters {
        let path: String = splitter
            .path
            .iter()
            .map(|second| if *second { '1' } else { '0' })
            .collect();
        let mut node = Node::new(
            &format!("split:{path}"),
            Role::Separator,
            "Resize",
            splitter.rect,
        );
        node.state.description = Some(format!(
            "{} of {} cells",
            splitter.first_len, splitter.available
        ));
        root.children.push(node.id.clone());
        nodes.push(node);
    }
    // A group with no rectangle this frame is still on the tree, so the person
    // or agent who cannot see it can find it and say why it is not shown.
    for (id, why) in &frame.suppressed {
        // What a companion leaves out is the conversation beside it, not a
        // group to find and show.
        if model.companion_hidden() == Some(*id) {
            continue;
        }
        let reason = match why {
            Suppressed::Hidden => "Hidden. Show the group to see it.",
            Suppressed::Collapsed => "Not shown: the window has no room for every panel.",
            Suppressed::Maximized => "Not shown: another panel is maximized.",
        };
        root.children
            .push(unshown_group(model, *id, reason, &mut nodes));
    }
    for drawer in frame.drawers.iter().filter(|d| !d.open) {
        root.children.push(unshown_group(
            model,
            drawer.group,
            "Collapsed to a drawer. Focus a tab in it, by its chord or tab.focus, to open the drawer.",
            &mut nodes,
        ));
    }
    // The notice row, by the same words it is drawn with.
    if let (Some(row), Some(line)) = (model.notice_rect(vp.area), model.notice_line()) {
        let mut node = Node::new("notice", Role::Status, &line.text, row);
        node.state.description = Some(if line.persistent {
            format!("{}, standing", line.severity.word())
        } else {
            line.severity.word().to_owned()
        });
        root.children.push(node.id.clone());
        nodes.push(node);
    }
    // Follow the agent: shown once a run is followed or the person paused it.
    // The two actions are always listed; the one that does nothing is disabled.
    let follow = model.follow();
    if follow.runs > 0 || !follow.on {
        let label = if !follow.on {
            "Follow paused".to_owned()
        } else {
            format!(
                "Following {} run{}",
                follow.runs,
                if follow.runs == 1 { "" } else { "s" }
            )
        };
        let mut node = Node::new("follow", Role::Status, &label, Rect::default());
        node.actions = [("follow.pause", follow.on), ("follow.resume", !follow.on)]
            .into_iter()
            .map(|(id, enabled)| NodeAction {
                id: ActionId::new(id),
                enabled,
                reason: (!enabled).then(|| "Already in that state".to_owned()),
                title: None,
            })
            .collect();
        root.children.push(node.id.clone());
        nodes.push(node);
    }
    describe_frame(frame, &mut root);
    nodes.insert(0, root);
    title_actions(model, &mut nodes);
    nodes.iter_mut().for_each(spell_out);
    SemanticTree {
        root: NodeId::new(ROOT),
        nodes,
    }
}

/// What a reader or an agent is told is never raw. A name, a shortcut and an
/// action's title or reason have their control and hidden characters spelled
/// out, as `visible` does. A description and a text with no selection are
/// several lines, so newline and tab keep their shape (`escaped`). A text with
/// a selection is the panel's own escaped text (`caret_text`), whose offsets
/// count into it, so it is left as it is. Ids are identifiers, never shown or
/// spoken, and stay as they are.
fn spell_out(node: &mut Node) {
    let strict = |s: &mut String| *s = visible(s);
    strict(&mut node.name);
    node.shortcut.iter_mut().for_each(strict);
    for action in &mut node.actions {
        action.reason.iter_mut().for_each(strict);
        action.title.iter_mut().for_each(strict);
    }
    let lines = |s: &mut String| *s = escaped(s);
    node.state.description.iter_mut().for_each(lines);
    if node.selection.is_none() {
        node.text.iter_mut().for_each(lines);
    }
}

fn describe_frame(frame: &SolvedFrame, root: &mut Node) {
    use theorem_workbench_dock::Presentation;
    root.state.description = match frame.presentation {
        Presentation::Tiled => None,
        Presentation::Principal => Some("One panel shown at a time".to_owned()),
        Presentation::Maximized => Some("One panel maximized".to_owned()),
    };
}

/// A group that has no rectangle in this frame: its tabs, each by name, and
/// why it is not drawn.
fn unshown_group(model: &Model, id: GroupId, reason: &str, out: &mut Vec<Node>) -> NodeId {
    let group = model.dock().group(id);
    let name = match group.map(|g| g.role()) {
        Some(DockRole::Files) => "Files",
        Some(DockRole::Main) => "Main",
        Some(DockRole::Tools) => "Tools",
        None => "Group",
    };
    let gid = id.raw();
    let mut node = Node::new(&format!("group:{gid}"), Role::Group, name, Rect::default());
    node.state.disabled = true;
    node.state.description = Some(reason.to_owned());
    let mut strip = Node::new(
        &format!("tabs:{gid}"),
        Role::TabList,
        &format!("{name} tabs"),
        Rect::default(),
    );
    for tab in group.map(|g| g.tabs()).unwrap_or(&[]) {
        let pid = PanelInstanceId::new(tab.panel.0.clone());
        let mut tab_node = Node::new(
            &format!("tab:{}", pid.as_str()),
            Role::Tab,
            &model.tab_label(&pid, &tab.title).title,
            Rect::default(),
        );
        tab_node.state.selected =
            group.is_some_and(|g| g.active().is_some_and(|a| a.panel == tab.panel));
        tab_node.state.disabled = tab.unavailable;
        tab_node.actions = tab_actions(&pid);
        describe_presentation(model, &pid, &mut tab_node);
        if let Some(binding) = model.panels.get(&pid).and_then(|e| e.panel.binding()) {
            tab_node.binding = binding.resource;
            tab_node.revision = binding.revision;
        }
        strip.children.push(tab_node.id.clone());
        out.push(tab_node);
    }
    node.children.push(strip.id.clone());
    out.push(strip);
    let id = node.id.clone();
    out.push(node);
    id
}

/// Push the nodes of one group and return the group node's id.
fn group_nodes(model: &Model, group: &GroupFrame, cx: &ViewCtx, out: &mut Vec<Node>) -> NodeId {
    let name = match group.role {
        DockRole::Files => "Files",
        DockRole::Main => "Main",
        DockRole::Tools => "Tools",
    };
    let gid = group.id.raw();
    let mut group_node = Node::new(&format!("group:{gid}"), Role::Group, name, group.rect);
    group_node.state.focused = group.focused;
    if group.overlay {
        group_node.state.description = Some(
            "Drawer, open. Escape or the Close the drawer action closes it; moving focus to \
             another panel closes it too."
                .to_owned(),
        );
    }

    let mut strip = Node::new(
        &format!("tabs:{gid}"),
        Role::TabList,
        &format!("{name} tabs"),
        group.tab_strip,
    );
    let tabs = model
        .dock()
        .group(group.id)
        .map(|g| g.tabs())
        .unwrap_or(&[]);
    for tab in &group.tabs {
        let pid = PanelInstanceId::new(tab.panel.0.clone());
        let registered = tabs
            .iter()
            .find(|t| t.panel == tab.panel)
            .map_or("", |t| t.title.as_str());
        let label = model.tab_label(&pid, registered);
        let mut node = Node::new(
            &format!("tab:{}", pid.as_str()),
            Role::Tab,
            &label.title,
            tab.rect,
        );
        node.state.modified = label.modified;
        node.state.selected = tab.active;
        node.state.focused = tab.active && group.focused;
        node.state.disabled = tab.unavailable;
        node.actions = tab_actions(&pid);
        describe_presentation(model, &pid, &mut node);
        if let Some(binding) = model.panels.get(&pid).and_then(|e| e.panel.binding()) {
            node.binding = binding.resource;
            node.revision = binding.revision;
        }
        strip.children.push(node.id.clone());
        out.push(node);
    }
    if group.tabs_before > 0 || group.tabs_after > 0 {
        strip.state.description = Some(format!(
            "{} tabs scrolled out before, {} after",
            group.tabs_before, group.tabs_after
        ));
    }
    group_node.children.push(strip.id.clone());
    out.push(strip);

    if let Some(active) = &group.active {
        let pid = PanelInstanceId::new(active.0.clone());
        let registered = tabs
            .iter()
            .find(|t| t.panel == *active)
            .map_or("", |t| t.title.as_str());
        let title = model.tab_label(&pid, registered).title;
        let mut body = Node::new(
            &format!("body:{}", pid.as_str()),
            Role::TabPanel,
            &title,
            group.body,
        );
        body.state.focused = group.focused;
        if let Some(entry) = model.panels.get(&pid) {
            let mut nodes = entry.panel.semantics(group.body, cx);
            if !nodes.is_empty() {
                // Panel ids are local: put each under the panel's id so two
                // panels cannot collide.
                for node in &mut nodes {
                    node.id = scoped(&pid, &node.id);
                    node.children = node.children.iter().map(|c| scoped(&pid, c)).collect();
                }
                body.children.push(nodes[0].id.clone());
                out.extend(nodes);
            }
            if let Some(binding) = entry.panel.binding() {
                body.binding = binding.resource;
                body.revision = binding.revision;
            } else {
                body.binding = ResourceRef::None;
            }
        }
        group_node.children.push(body.id.clone());
        out.push(body);
    }

    let id = group_node.id.clone();
    out.push(group_node);
    id
}

/// Give every action a title a person would read. A panel may set its own; the
/// rest come from the registry's descriptor, and the actions the core makes up
/// per panel or per row (they are not registered) from the node they sit on.
fn title_actions(model: &Model, nodes: &mut [Node]) {
    use crate::panels::{ACTION_DELEGATION_OPEN, ACTION_PIN, ACTION_UNPIN};
    use crate::presentation::{ACTION_PRESENTATION, ACTION_PRESENTATION_NEXT, PRESENTATION_USE};
    for node in nodes.iter_mut() {
        let name = node.name.clone();
        for action in node.actions.iter_mut().filter(|a| a.title.is_none()) {
            let id = action.id.as_str();
            let from =
                |prefix: &str, verb: &str| id.starts_with(prefix).then(|| format!("{verb} {name}"));
            action.title = model
                .registry()
                .action(&action.id)
                .map(|(_, d)| d.title.clone())
                .or_else(|| from(ACTION_TAB_FOCUS, "Focus"))
                .or_else(|| from(ACTION_TAB_CLOSE, "Close"))
                .or_else(|| from(ACTION_DELEGATION_OPEN, "Open"))
                .or_else(|| from(ACTION_PIN, "Pin"))
                .or_else(|| from(ACTION_UNPIN, "Unpin"))
                .or_else(|| {
                    id.strip_prefix(PRESENTATION_USE)
                        .map(|kind| format!("Show as {kind}"))
                })
                .or_else(|| (id == ACTION_PRESENTATION).then(|| "Change presentation".to_owned()))
                .or_else(|| {
                    (id == ACTION_PRESENTATION_NEXT).then(|| "Next presentation".to_owned())
                });
        }
    }
}

/// What a tab offers: show its panel, or close the view (never what it shows).
fn tab_actions(panel: &PanelInstanceId) -> Vec<NodeAction> {
    [ACTION_TAB_FOCUS, ACTION_TAB_CLOSE]
        .iter()
        .map(|prefix| NodeAction {
            id: ActionId::new(format!("{prefix}{}", panel.as_str())),
            enabled: true,
            reason: None,
            title: None,
        })
        .collect()
}

/// How a document panel is shown now and the other ways it can be: the
/// description names the current presentation and its version, and the
/// actions swap it. They are the ones the keyboard and the chooser run, and an
/// agent may run them (a presentation change is not a mutation). Nothing for a
/// panel no presentation is declared for.
fn describe_presentation(model: &Model, panel: &PanelInstanceId, node: &mut Node) {
    use crate::presentation::{ACTION_PRESENTATION, ACTION_PRESENTATION_NEXT, PRESENTATION_USE};
    let entries = model.presentations_of(panel);
    if entries.is_empty() {
        return;
    }
    node.state.description = Some(match entries.iter().find(|e| e.current) {
        Some(e) => format!("Shown as {} (version {})", e.title, e.version),
        None => "Shown as a presentation this build cannot serve. Choose another.".to_owned(),
    });
    let another = entries
        .iter()
        .any(|e| !e.current && e.availability.is_available());
    node.actions.push(NodeAction {
        id: ActionId::new(ACTION_PRESENTATION),
        enabled: another,
        reason: (!another).then(|| "No other presentation can show this document.".to_owned()),
        title: None,
    });
    node.actions.push(NodeAction {
        id: ActionId::new(ACTION_PRESENTATION_NEXT),
        enabled: another,
        reason: (!another).then(|| "No other presentation can show this document.".to_owned()),
        title: None,
    });
    for e in &entries {
        let (enabled, reason) = match (&e.availability, e.current) {
            (_, true) => (false, Some("Already shown this way.".to_owned())),
            (Availability::Unavailable { reason }, _) => (false, Some(reason.clone())),
            (Availability::Available, false) => (true, None),
        };
        node.actions.push(NodeAction {
            id: ActionId::new(format!("{PRESENTATION_USE}{}", e.kind.as_str())),
            enabled,
            reason,
            title: None,
        });
    }
}

fn scoped(panel: &PanelInstanceId, local: &NodeId) -> NodeId {
    NodeId::new(format!("{}/{}", panel.as_str(), local.as_str()))
}
