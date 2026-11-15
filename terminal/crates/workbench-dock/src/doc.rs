//! The persisted layout document: versioned, serde, validated on restore.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use theorem_workbench_layout::{SavedLayout, TileLayout};

use crate::dock::{Dock, Group};
use crate::types::*;

pub const SCHEMA: &str = "theorem.workbench.dock";
pub const VERSION: u32 = 1;

/// Everything about an arrangement that is worth saving: the split tree with
/// its ratios and focus, each group's tabs, and hidden/maximized state. Cell
/// sizes, the config and the open drawer are device-local and not saved.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DockDocument {
    pub schema: String,
    pub version: u32,
    pub layout: SavedLayout,
    pub groups: BTreeMap<GroupId, GroupDoc>,
    #[serde(default)]
    pub maximized: Option<GroupId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroupDoc {
    pub role: Role,
    pub tabs: Vec<Tab>,
    #[serde(default)]
    pub active: Option<PanelId>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub keep_empty: bool,
    #[serde(default)]
    pub pinned_px: Option<f32>,
}

/// A fix `restore` applied to a document that was readable but inconsistent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Repair {
    /// The active tab named no tab in the group; the first tab is active.
    ActiveTab(GroupId),
    /// The maximized group was missing or hidden; maximize was cleared.
    Maximized(GroupId),
    /// A pixel target was not a positive number; it was dropped.
    PinnedPx(GroupId),
    /// Every group was hidden; this one was shown.
    AllHidden(GroupId),
    /// Focus was on a hidden group; it moved to this one.
    Focus(GroupId),
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RestoreReport {
    pub repairs: Vec<Repair>,
    /// Panels whose kind the caller does not know. They stay as placeholders.
    pub unavailable: Vec<PanelId>,
}

impl Dock {
    /// The document for the current arrangement.
    pub fn document(&self) -> DockDocument {
        let groups = self
            .groups
            .iter()
            .map(|(id, g)| {
                let doc = GroupDoc {
                    role: g.role,
                    // The placeholder mark is runtime state, not part of the document.
                    tabs: g
                        .tabs
                        .iter()
                        .map(|t| Tab {
                            unavailable: false,
                            ..t.clone()
                        })
                        .collect(),
                    active: g.active.map(|i| g.tabs[i].panel.clone()),
                    hidden: g.hidden,
                    keep_empty: g.keep_empty,
                    pinned_px: g.pinned_px,
                };
                (*id, doc)
            })
            .collect();
        DockDocument {
            schema: SCHEMA.to_owned(),
            version: VERSION,
            layout: self.layout.save(),
            groups,
            maximized: self.maximized,
        }
    }

    /// Rebuild a dock from a document. Structural damage (unknown schema or
    /// version, a bad tree, groups that do not match it, a panel in two tabs)
    /// is refused. Smaller inconsistencies are repaired and reported. Tabs
    /// whose kind `is_known` rejects are kept and marked unavailable. A
    /// document that needs no repair restores to a dock whose `document()` is
    /// equal to it.
    pub fn restore(
        doc: DockDocument,
        cfg: DockConfig,
        is_known: impl Fn(&PanelKind) -> bool,
    ) -> Result<(Dock, RestoreReport), RestoreError> {
        if doc.schema != SCHEMA {
            return Err(RestoreError::UnknownSchema(doc.schema));
        }
        if doc.version != VERSION {
            return Err(RestoreError::UnsupportedVersion {
                found: doc.version,
                supported: VERSION,
            });
        }
        let mut layout = TileLayout::restore(doc.layout)?;
        let leaves: BTreeSet<GroupId> = layout.pane_ids().into_iter().collect();
        if let Some(id) = leaves.iter().find(|id| !doc.groups.contains_key(id)) {
            return Err(RestoreError::MissingGroup(*id));
        }
        if let Some(id) = doc.groups.keys().find(|id| !leaves.contains(id)) {
            return Err(RestoreError::OrphanGroup(*id));
        }
        let mut seen = BTreeSet::new();
        for tab in doc.groups.values().flat_map(|g| &g.tabs) {
            if !seen.insert(tab.panel.clone()) {
                return Err(RestoreError::DuplicatePanel(tab.panel.clone()));
            }
        }

        let mut report = RestoreReport::default();
        let mut groups = BTreeMap::new();
        for (id, g) in doc.groups {
            let mut tabs = g.tabs;
            for t in &mut tabs {
                t.unavailable = !is_known(&t.kind);
                if t.unavailable {
                    report.unavailable.push(t.panel.clone());
                }
            }
            let active = match g.active {
                Some(p) => match tabs.iter().position(|t| t.panel == p) {
                    Some(i) => Some(i),
                    None => {
                        report.repairs.push(Repair::ActiveTab(id));
                        (!tabs.is_empty()).then_some(0)
                    }
                },
                None if tabs.is_empty() => None,
                None => {
                    report.repairs.push(Repair::ActiveTab(id));
                    Some(0)
                }
            };
            let pinned_px = match g.pinned_px {
                Some(px) if !(px.is_finite() && px > 0.0) => {
                    report.repairs.push(Repair::PinnedPx(id));
                    None
                }
                other => other,
            };
            groups.insert(
                id,
                Group {
                    role: g.role,
                    tabs,
                    active,
                    hidden: g.hidden,
                    keep_empty: g.keep_empty,
                    pinned_px,
                },
            );
        }

        if groups.values().all(|g| g.hidden) {
            let first = layout.pane_ids()[0];
            groups.get_mut(&first).expect("leaf").hidden = false;
            report.repairs.push(Repair::AllHidden(first));
        }
        let maximized = match doc.maximized {
            Some(m) if groups.get(&m).is_some_and(|g| !g.hidden) => Some(m),
            Some(m) => {
                report.repairs.push(Repair::Maximized(m));
                None
            }
            None => None,
        };
        if groups[&layout.focused()].hidden {
            let to = layout
                .pane_ids()
                .into_iter()
                .find(|id| !groups[id].hidden)
                .expect("a group is visible");
            layout.focus_pane(to);
            report.repairs.push(Repair::Focus(to));
        }

        let dock = Dock {
            cfg,
            layout,
            groups,
            maximized,
            drawer: None,
        };
        Ok((dock, report))
    }
}
