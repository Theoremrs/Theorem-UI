//! The semantic tree: what the accessible DOM and the agent's `workbench.read`
//! both read, so the human, assistive and agent views cannot disagree
//! (ARCHITECTURE section 8). Rust emits it; React renders one element per node.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::ids::{ActionId, ResourceRef, Revision};
use crate::string_id;

string_id!(
    /// A node's stable identity: a panel instance, or a control inside one.
    NodeId
);

/// The roles the spec's surfaces need, each mapping onto one ARIA role.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Role {
    /// The workbench itself.
    Application,
    /// A panel: a landmark with a name.
    Region,
    Toolbar,
    Group,
    Heading,
    Button,
    /// The tool picker.
    Menu,
    MenuItem,
    TabList,
    Tab,
    TabPanel,
    /// The file tree.
    Tree,
    TreeItem,
    /// A multiline text surface: the composer, the editor.
    TextBox,
    /// The transcript.
    Log,
    /// A live indicator, such as the terminal controller state.
    Status,
    Alert,
    Dialog,
    /// A splitter.
    Separator,
    /// A diff or a rendered Markdown block.
    Document,
}

impl Role {
    pub fn aria(self) -> &'static str {
        match self {
            Self::Application => "application",
            Self::Region => "region",
            Self::Toolbar => "toolbar",
            Self::Group => "group",
            Self::Heading => "heading",
            Self::Button => "button",
            Self::Menu => "menu",
            Self::MenuItem => "menuitem",
            Self::TabList => "tablist",
            Self::Tab => "tab",
            Self::TabPanel => "tabpanel",
            Self::Tree => "tree",
            Self::TreeItem => "treeitem",
            Self::TextBox => "textbox",
            Self::Log => "log",
            Self::Status => "status",
            Self::Alert => "alert",
            Self::Dialog => "dialog",
            Self::Separator => "separator",
            Self::Document => "document",
        }
    }
}

/// A rectangle in terminal cells.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CellRect {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", default)]
pub struct NodeState {
    pub focused: bool,
    pub selected: bool,
    pub disabled: bool,
    pub busy: bool,
    pub expanded: Option<bool>,
    /// Why the node is unavailable or refused, in words a person can act on.
    pub description: Option<String>,
}

/// An action the node offers, by registry id, with its availability.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct NodeAction {
    pub id: ActionId,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: NodeId,
    pub role: Role,
    pub name: String,
    pub state: NodeState,
    pub rect: CellRect,
    pub actions: Vec<NodeAction>,
    pub binding: ResourceRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub revision: Option<Revision>,
    /// Depth in a tree, counted from 1 (`aria-level`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub level: Option<u16>,
    /// Position among the item's siblings, counted from 1 (`aria-posinset`).
    /// Always given together with `set_size`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub pos_in_set: Option<u16>,
    /// How many siblings there are, counting the item (`aria-setsize`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub set_size: Option<u16>,
    /// The chord that does what the node does, as people read it
    /// (`aria-keyshortcuts`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub shortcut: Option<String>,
    /// Children in reading order. A node has exactly one parent.
    pub children: Vec<NodeId>,
}

impl CellRect {
    pub fn of(rect: ratatui::layout::Rect) -> Self {
        Self {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        }
    }
}

impl Node {
    /// A node with default state, no actions, no binding and no children.
    pub fn new(id: &str, role: Role, name: &str, rect: ratatui::layout::Rect) -> Self {
        Self {
            id: NodeId::new(id),
            role,
            name: name.to_owned(),
            state: NodeState::default(),
            rect: CellRect::of(rect),
            actions: vec![],
            binding: ResourceRef::None,
            revision: None,
            level: None,
            pos_in_set: None,
            set_size: None,
            shortcut: None,
            children: vec![],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SemanticTree {
    pub root: NodeId,
    pub nodes: Vec<Node>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum TreeError {
    DuplicateNode {
        id: NodeId,
    },
    MissingRoot,
    MissingChild {
        parent: NodeId,
        child: NodeId,
    },
    /// A node listed under two parents, or the root listed as a child: more
    /// than one accessible owner.
    SecondParent {
        child: NodeId,
    },
    /// A node no path from the root reaches.
    Unreachable {
        id: NodeId,
    },
    /// A `level` of 0: levels count from 1.
    BadLevel {
        id: NodeId,
    },
    /// A `pos_in_set` or `set_size` that cannot describe a place in a set:
    /// zero, past the end, or one given without the other.
    BadPosition {
        id: NodeId,
    },
}

/// The change from one published tree to the next, for the host to patch the
/// accessible DOM without rebuilding it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SemanticDiff {
    pub added: Vec<Node>,
    pub changed: Vec<Node>,
    pub removed: Vec<NodeId>,
    /// Set when the root node itself changed identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub root: Option<NodeId>,
}

impl SemanticDiff {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty()
            && self.changed.is_empty()
            && self.removed.is_empty()
            && self.root.is_none()
    }
}

impl SemanticTree {
    /// One accessible owner per node: every id once, every child present, one
    /// parent each, and everything reachable from the root.
    pub fn validate(&self) -> Result<(), TreeError> {
        let mut by_id: BTreeMap<&NodeId, &Node> = BTreeMap::new();
        for node in &self.nodes {
            if by_id.insert(&node.id, node).is_some() {
                return Err(TreeError::DuplicateNode {
                    id: node.id.clone(),
                });
            }
        }
        if !by_id.contains_key(&self.root) {
            return Err(TreeError::MissingRoot);
        }
        for node in &self.nodes {
            if node.level == Some(0) {
                return Err(TreeError::BadLevel {
                    id: node.id.clone(),
                });
            }
            let position_ok = match (node.pos_in_set, node.set_size) {
                (None, None) => true,
                (Some(pos), Some(size)) => pos >= 1 && pos <= size,
                _ => false,
            };
            if !position_ok {
                return Err(TreeError::BadPosition {
                    id: node.id.clone(),
                });
            }
        }
        let mut owned: BTreeSet<&NodeId> = BTreeSet::new();
        for node in &self.nodes {
            for child in &node.children {
                if !by_id.contains_key(child) {
                    return Err(TreeError::MissingChild {
                        parent: node.id.clone(),
                        child: child.clone(),
                    });
                }
                if child == &self.root || !owned.insert(child) {
                    return Err(TreeError::SecondParent {
                        child: child.clone(),
                    });
                }
            }
        }
        // Every non-root node has a parent; a parent cycle detached from the
        // root shows up as unreachable.
        let mut seen: BTreeSet<&NodeId> = BTreeSet::new();
        let mut stack = vec![&self.root];
        while let Some(id) = stack.pop() {
            if seen.insert(id) {
                stack.extend(by_id[id].children.iter());
            }
        }
        match self.nodes.iter().find(|n| !seen.contains(&n.id)) {
            Some(node) => Err(TreeError::Unreachable {
                id: node.id.clone(),
            }),
            None => Ok(()),
        }
    }

    pub fn node(&self, id: &NodeId) -> Option<&Node> {
        self.nodes.iter().find(|n| &n.id == id)
    }

    /// What changed from `previous` to `self`. Order follows each tree's own
    /// node order.
    pub fn diff_from(&self, previous: &SemanticTree) -> SemanticDiff {
        let before: BTreeMap<&NodeId, &Node> = previous.nodes.iter().map(|n| (&n.id, n)).collect();
        let after: BTreeSet<&NodeId> = self.nodes.iter().map(|n| &n.id).collect();
        let mut diff = SemanticDiff::default();
        for node in &self.nodes {
            match before.get(&node.id) {
                None => diff.added.push(node.clone()),
                Some(old) if *old != node => diff.changed.push(node.clone()),
                Some(_) => {}
            }
        }
        diff.removed = previous
            .nodes
            .iter()
            .filter(|n| !after.contains(&n.id))
            .map(|n| n.id.clone())
            .collect();
        if previous.root != self.root {
            diff.root = Some(self.root.clone());
        }
        diff
    }

    /// Apply a diff to a copy of `self`; the host's DOM does the same patch.
    pub fn apply(&self, diff: &SemanticDiff) -> SemanticTree {
        let mut nodes: Vec<Node> = self
            .nodes
            .iter()
            .filter(|n| !diff.removed.contains(&n.id))
            .cloned()
            .collect();
        for changed in &diff.changed {
            if let Some(slot) = nodes.iter_mut().find(|n| n.id == changed.id) {
                *slot = changed.clone();
            }
        }
        nodes.extend(diff.added.iter().cloned());
        SemanticTree {
            root: diff.root.clone().unwrap_or_else(|| self.root.clone()),
            nodes,
        }
    }
}

/// Publishes a tree as diffs. Keeping only the last tree sent means several
/// state changes between frames reach the host as one diff that holds all of
/// them: coalescing redraws never drops a semantic update.
#[derive(Debug, Default)]
pub struct SemanticPublisher {
    last: Option<SemanticTree>,
}

pub enum Publish {
    /// The first tree, or the host asked for a fresh start.
    Full(SemanticTree),
    Diff(SemanticDiff),
    Unchanged,
}

impl SemanticPublisher {
    pub fn publish(&mut self, tree: SemanticTree) -> Publish {
        let out = match &self.last {
            None => Publish::Full(tree.clone()),
            Some(last) => {
                let diff = tree.diff_from(last);
                if diff.is_empty() {
                    Publish::Unchanged
                } else {
                    Publish::Diff(diff)
                }
            }
        };
        self.last = Some(tree);
        out
    }

    /// The host remounted: the next publish is a full tree.
    pub fn reset(&mut self) {
        self.last = None;
    }

    pub fn current(&self) -> Option<&SemanticTree> {
        self.last.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, role: Role, children: &[&str]) -> Node {
        Node {
            id: NodeId::new(id),
            role,
            name: id.to_owned(),
            state: NodeState::default(),
            rect: CellRect {
                x: 0,
                y: 0,
                width: 10,
                height: 1,
            },
            actions: vec![],
            binding: ResourceRef::None,
            revision: None,
            level: None,
            pos_in_set: None,
            set_size: None,
            shortcut: None,
            children: children.iter().map(|c| NodeId::new(*c)).collect(),
        }
    }

    fn tree() -> SemanticTree {
        SemanticTree {
            root: NodeId::new("app"),
            nodes: vec![
                node("app", Role::Application, &["files", "theo"]),
                node("files", Role::Tree, &["a.md"]),
                node("a.md", Role::TreeItem, &[]),
                node("theo", Role::Region, &[]),
            ],
        }
    }

    #[test]
    fn a_well_formed_tree_validates() {
        assert_eq!(tree().validate(), Ok(()));
    }

    #[test]
    fn two_parents_means_two_accessible_owners() {
        let mut t = tree();
        t.nodes[3].children.push(NodeId::new("a.md"));
        assert_eq!(
            t.validate(),
            Err(TreeError::SecondParent {
                child: NodeId::new("a.md")
            })
        );
    }

    #[test]
    fn dangling_orphan_and_duplicate_nodes_are_refused() {
        let mut dangling = tree();
        dangling.nodes[3].children.push(NodeId::new("ghost"));
        assert!(matches!(
            dangling.validate(),
            Err(TreeError::MissingChild { .. })
        ));

        let mut orphan = tree();
        orphan.nodes.push(node("lost", Role::Button, &[]));
        assert_eq!(
            orphan.validate(),
            Err(TreeError::Unreachable {
                id: NodeId::new("lost")
            })
        );

        let mut dup = tree();
        dup.nodes.push(node("theo", Role::Region, &[]));
        assert!(matches!(
            dup.validate(),
            Err(TreeError::DuplicateNode { .. })
        ));
    }

    #[test]
    fn level_and_position_are_checked_and_round_trip() {
        let mut t = tree();
        t.nodes[2].level = Some(2);
        t.nodes[2].pos_in_set = Some(3);
        t.nodes[2].set_size = Some(7);
        assert_eq!(t.validate(), Ok(()));
        let value = serde_json::to_value(&t.nodes[2]).unwrap();
        assert_eq!(value["level"], 2);
        assert_eq!(value["posInSet"], 3);
        assert_eq!(value["setSize"], 7);
        // Absent when not given.
        let plain = serde_json::to_value(&t.nodes[1]).unwrap();
        assert!(plain.get("level").is_none() && plain.get("posInSet").is_none());
        assert_eq!(serde_json::from_value::<Node>(value).unwrap(), t.nodes[2]);

        let id = t.nodes[2].id.clone();
        let mut zero = t.clone();
        zero.nodes[2].level = Some(0);
        assert_eq!(zero.validate(), Err(TreeError::BadLevel { id: id.clone() }));
        for (pos, size) in [
            (Some(8), Some(7)),
            (Some(0), Some(7)),
            (Some(1), None),
            (None, Some(7)),
        ] {
            let mut bad = t.clone();
            bad.nodes[2].pos_in_set = pos;
            bad.nodes[2].set_size = size;
            assert_eq!(
                bad.validate(),
                Err(TreeError::BadPosition { id: id.clone() })
            );
        }
    }

    #[test]
    fn diff_reports_added_changed_removed() {
        let before = tree();
        let mut after = tree();
        after.nodes[3].state.focused = true; // changed
        after.nodes.remove(2); // a.md removed
        after.nodes[1].children.clear();
        after.nodes.push(node("picker", Role::Menu, &[]));
        after.nodes[0].children.push(NodeId::new("picker"));
        let diff = after.diff_from(&before);
        let names = |nodes: &[Node]| {
            nodes
                .iter()
                .map(|n| n.id.as_str().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(&diff.added), vec!["picker"]);
        assert_eq!(names(&diff.changed), vec!["app", "files", "theo"]);
        assert_eq!(diff.removed, vec![NodeId::new("a.md")]);
        assert_eq!(diff.root, None);
    }

    #[test]
    fn applying_the_diff_rebuilds_the_next_tree() {
        let before = tree();
        let mut after = tree();
        after.nodes[3].name = "Theo, working".into();
        after.nodes.push(node("picker", Role::Menu, &[]));
        after.nodes[0].children.push(NodeId::new("picker"));
        let patched = before.apply(&after.diff_from(&before));
        let sort = |mut t: SemanticTree| {
            t.nodes.sort_by(|a, b| a.id.cmp(&b.id));
            t
        };
        assert_eq!(sort(patched), sort(after));
    }

    #[test]
    fn identical_trees_publish_nothing() {
        let mut publisher = SemanticPublisher::default();
        assert!(matches!(publisher.publish(tree()), Publish::Full(_)));
        assert!(matches!(publisher.publish(tree()), Publish::Unchanged));
    }

    #[test]
    fn changes_between_frames_arrive_in_one_diff() {
        // Two states change before the host is told; the diff carries both.
        let mut publisher = SemanticPublisher::default();
        publisher.publish(tree());
        let mut next = tree();
        next.nodes[3].name = "Theo, working".into();
        next.nodes[2].state.selected = true;
        let Publish::Diff(diff) = publisher.publish(next) else {
            panic!("expected a diff")
        };
        let ids: Vec<_> = diff.changed.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, vec!["a.md", "theo"]);
    }

    #[test]
    fn roles_map_to_aria() {
        assert_eq!(Role::TextBox.aria(), "textbox");
        assert_eq!(Role::Tree.aria(), "tree");
        assert_eq!(Role::MenuItem.aria(), "menuitem");
        assert_eq!(Role::Separator.aria(), "separator");
    }
}
