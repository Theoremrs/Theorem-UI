//! `semantics`: one tree for the whole workbench, composed from the dock and
//! each panel's own nodes (ARCHITECTURE section 8). The human, assistive and
//! agent views read the same tree.

use ratatui::layout::Rect;
use theorem_workbench_dock::{GroupFrame, GroupId, Role as DockRole, SolvedFrame, Suppressed};

use crate::ids::{PanelInstanceId, ResourceRef};
use crate::model::Model;
use crate::panel::ViewCtx;
use crate::semantics::{Node, NodeId, Role, SemanticTree};
use crate::theme::Theme;

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
            solved = model.dock().solve(vp.area, vp.metrics);
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
            "Collapsed to a drawer: open the drawer to see it.",
            &mut nodes,
        ));
    }
    describe_frame(frame, &mut root);
    nodes.insert(0, root);
    SemanticTree {
        root: NodeId::new(ROOT),
        nodes,
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
            &tab.title,
            Rect::default(),
        );
        tab_node.state.selected =
            group.is_some_and(|g| g.active().is_some_and(|a| a.panel == tab.panel));
        tab_node.state.disabled = tab.unavailable;
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
        let title = tabs
            .iter()
            .find(|t| t.panel == tab.panel)
            .map_or("", |t| t.title.as_str());
        let mut node = Node::new(&format!("tab:{}", pid.as_str()), Role::Tab, title, tab.rect);
        node.state.selected = tab.active;
        node.state.focused = tab.active && group.focused;
        node.state.disabled = tab.unavailable;
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
        let title = tabs
            .iter()
            .find(|t| t.panel == *active)
            .map_or("", |t| t.title.as_str());
        let mut body = Node::new(
            &format!("body:{}", pid.as_str()),
            Role::TabPanel,
            title,
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

fn scoped(panel: &PanelInstanceId, local: &NodeId) -> NodeId {
    NodeId::new(format!("{}/{}", panel.as_str(), local.as_str()))
}
