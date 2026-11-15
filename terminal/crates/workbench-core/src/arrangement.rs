//! Saved arrangements (spec 11, Gate 5): named layouts the person keeps beside
//! the built-in presets, applied without closing anything.
//!
//! The core holds the list and the current layout; the layout owner (the
//! account's workbench record) holds the truth. Every change goes out as a
//! [`LayoutSave`] against the revision last read, one at a time, and a save
//! the owner refuses is told, never assumed.
//!
//! Applying an arrangement is a change of places, not of panels: a panel that
//! is open stays open with its draft, its dirty document and its process, and
//! the arrangement only says where it sits.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use theorem_workbench_dock::{
    Dock, DockDocument, GroupId, OpenAt, PanelId, Preset, Role as DockRole, Tab,
};

use crate::completion::{Completion, CompletionPayload, Outcome};
use crate::effect::{Effect, EffectBody, LayoutSave};
use crate::ids::{PanelInstanceId, PanelKind, Revision};
use crate::model::{DOCUMENT_SCHEMA, DOCUMENT_VERSION, Entry, Model, Notice};
use crate::panels::PICKER_KIND;
use crate::stale::{Binding, Verdict};

pub const ARRANGEMENTS_SCHEMA: &str = "theorem.workbench.arrangements";
pub const ARRANGEMENTS_VERSION: u32 = 1;
/// How many arrangements a person may keep. Saving past it is refused, in a
/// notice.
pub const ARRANGEMENT_LIMIT: usize = 32;
/// The longest name, in characters.
pub const ARRANGEMENT_NAME_CHARS: usize = 64;

/// The built-in presets: id, label.
pub const PRESETS: [(&str, &str, Preset); 4] = [
    ("default", "Default", Preset::Default),
    ("editor", "Editor-centred", Preset::EditorCentered),
    ("agent", "Agent-centred", Preset::AgentCentered),
    ("minimal", "Minimal", Preset::Minimal),
];

/// What the person or an adapter asks of the arrangements.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ArrangementMsg {
    /// Read the record: the named layouts, and the layout the workbench was
    /// left in. Sent by the host after it starts and after an account change.
    Load,
    /// Keep the arrangement as it is now under `name` (replacing one of that
    /// name).
    Save {
        name: String,
    },
    /// Apply a preset (by id or label) or a saved arrangement.
    Apply {
        name: String,
    },
    Rename {
        from: String,
        to: String,
    },
    Delete {
        name: String,
    },
}

/// One row of the list the picker or a menu shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArrangementInfo {
    pub name: String,
    pub builtin: bool,
}

/// What an operation on the arrangements did or could not do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArrangementNotice {
    Applied {
        name: String,
    },
    /// Applied as far as this build could. `unavailable` are the panel kinds
    /// it has no panel for (kept as placeholders); `caveats` say what else.
    Partial {
        name: String,
        unavailable: Vec<String>,
        repairs: usize,
        caveats: Vec<String>,
    },
    /// Nothing was applied: the layout could not be read at all. The
    /// arrangement on screen is untouched.
    Unreadable {
        name: String,
        reason: String,
    },
    Unknown {
        name: String,
    },
    BadName {
        reason: String,
    },
    /// A preset's name, or one already held (renaming onto it).
    NameTaken {
        name: String,
    },
    StoreFull {
        limit: usize,
    },
    /// The owner did not take the save: the arrangement is kept here, not yet
    /// in the account.
    NotSaved {
        reason: String,
    },
    /// The record could not be read as arrangements; `skipped` entries were
    /// left out of what was kept.
    LoadedWithLoss {
        skipped: usize,
        reason: String,
    },
}

/// What was last sent for the layout record, so its answer is read for what it
/// was.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LayoutOp {
    Load,
    Save,
}

/// What a record holds: the arrangements kept, how many entries were skipped,
/// and a caveat when it is of another version.
type Record = (Vec<(String, Value)>, usize, Option<String>);

/// The account's arrangements, as last read or written.
#[derive(Default)]
pub(crate) struct Arrangements {
    pub(crate) items: Vec<(String, Value)>,
    /// The revision of the record the next save is made against.
    pub(crate) revision: Option<Revision>,
    /// A save is out; another change waits for its answer.
    pub(crate) saving: bool,
    pub(crate) save_again: bool,
}

impl Arrangements {
    fn find(&self, name: &str) -> Option<usize> {
        let key = fold(name);
        self.items.iter().position(|(n, _)| fold(n) == key)
    }

    fn to_text(&self) -> String {
        let items: Vec<Value> = self
            .items
            .iter()
            .map(|(name, document)| json!({"name": name, "document": document}))
            .collect();
        json!({
            "schema": ARRANGEMENTS_SCHEMA,
            "version": ARRANGEMENTS_VERSION,
            "items": items,
        })
        .to_string()
    }

    /// Read what the record holds. An entry that is not a named document is
    /// skipped and counted; a newer version is read as far as it matches.
    fn from_text(text: &str) -> Result<Record, String> {
        if text.trim().is_empty() {
            return Ok((vec![], 0, None));
        }
        let value: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
        if value.get("schema").and_then(Value::as_str) != Some(ARRANGEMENTS_SCHEMA) {
            return Err("it is not a list of arrangements".into());
        }
        let version = value.get("version").and_then(Value::as_u64).unwrap_or(0);
        let caveat = (version != u64::from(ARRANGEMENTS_VERSION)).then(|| {
            format!(
                "the list was saved by version {version}; this build reads {ARRANGEMENTS_VERSION}"
            )
        });
        let mut items = Vec::new();
        let mut skipped = 0;
        for entry in value
            .get("items")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
        {
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|n| !n.is_empty() && n.chars().count() <= ARRANGEMENT_NAME_CHARS);
            let document = entry.get("document").filter(|d| d.is_object());
            match (name, document) {
                (Some(name), Some(document))
                    if items.len() < ARRANGEMENT_LIMIT
                        && !items
                            .iter()
                            .any(|(n, _): &(String, Value)| fold(n) == fold(name)) =>
                {
                    items.push((name.to_owned(), document.clone()));
                }
                _ => skipped += 1,
            }
        }
        Ok((items, skipped, caveat))
    }
}

fn fold(name: &str) -> String {
    name.trim().to_lowercase()
}

fn preset_named(name: &str) -> Option<(&'static str, Preset)> {
    let key = fold(name);
    PRESETS
        .iter()
        .find(|(id, label, _)| fold(id) == key || fold(label) == key)
        .map(|(id, _, preset)| (*id, *preset))
}

/// A live panel and where it sat.
struct Live {
    id: PanelInstanceId,
    kind: String,
    role: DockRole,
    tab: Tab,
}

enum Target {
    Preset(Preset),
    Saved(Value),
}

impl Model {
    /// The presets, then the saved arrangements in the order they were made.
    pub fn arrangements(&self) -> Vec<ArrangementInfo> {
        PRESETS
            .iter()
            .map(|(_, label, _)| ArrangementInfo {
                name: (*label).to_owned(),
                builtin: true,
            })
            .chain(
                self.arrangements
                    .items
                    .iter()
                    .map(|(name, _)| ArrangementInfo {
                        name: name.clone(),
                        builtin: false,
                    }),
            )
            .collect()
    }

    pub(crate) fn on_arrangement(&mut self, msg: ArrangementMsg) -> Vec<Effect> {
        match msg {
            ArrangementMsg::Load => self.send_layout(EffectBody::LayoutLoad, LayoutOp::Load, None),
            ArrangementMsg::Save { name } => {
                let name = match self.valid_name(&name) {
                    Ok(name) => name,
                    Err(notice) => return self.say(notice),
                };
                if preset_named(&name).is_some() {
                    return self.say(ArrangementNotice::NameTaken { name });
                }
                let document = self.document();
                match self.arrangements.find(&name) {
                    Some(at) => self.arrangements.items[at] = (name, document),
                    None if self.arrangements.items.len() >= ARRANGEMENT_LIMIT => {
                        return self.say(ArrangementNotice::StoreFull {
                            limit: ARRANGEMENT_LIMIT,
                        });
                    }
                    None => self.arrangements.items.push((name, document)),
                }
                self.save_arrangements()
            }
            ArrangementMsg::Apply { name } => {
                if let Some((id, preset)) = preset_named(&name) {
                    self.apply(id, Target::Preset(preset));
                } else if let Some(at) = self.arrangements.find(&name) {
                    let (stored, document) = self.arrangements.items[at].clone();
                    self.apply(&stored, Target::Saved(document));
                } else {
                    self.notify(Notice::Arrangement(ArrangementNotice::Unknown { name }));
                }
                vec![]
            }
            ArrangementMsg::Rename { from, to } => {
                let to = match self.valid_name(&to) {
                    Ok(name) => name,
                    Err(notice) => return self.say(notice),
                };
                let Some(at) = self.arrangements.find(&from) else {
                    return self.say(ArrangementNotice::Unknown { name: from });
                };
                let clash = self.arrangements.find(&to).is_some_and(|other| other != at);
                if clash || preset_named(&to).is_some() {
                    return self.say(ArrangementNotice::NameTaken { name: to });
                }
                self.arrangements.items[at].0 = to;
                self.save_arrangements()
            }
            ArrangementMsg::Delete { name } => {
                let Some(at) = self.arrangements.find(&name) else {
                    return self.say(ArrangementNotice::Unknown { name });
                };
                self.arrangements.items.remove(at);
                self.save_arrangements()
            }
        }
    }

    fn say(&mut self, notice: ArrangementNotice) -> Vec<Effect> {
        self.notify(Notice::Arrangement(notice));
        vec![]
    }

    fn valid_name(&self, name: &str) -> Result<String, ArrangementNotice> {
        let name = name.trim();
        if name.is_empty() {
            return Err(ArrangementNotice::BadName {
                reason: "A name is needed.".into(),
            });
        }
        if name.chars().count() > ARRANGEMENT_NAME_CHARS {
            return Err(ArrangementNotice::BadName {
                reason: format!("A name is at most {ARRANGEMENT_NAME_CHARS} characters."),
            });
        }
        Ok(name.to_owned())
    }

    /// Send the arrangements and the layout as it is. One save is out at a
    /// time; a change made meanwhile goes out when it is answered.
    fn save_arrangements(&mut self) -> Vec<Effect> {
        if self.arrangements.saving {
            self.arrangements.save_again = true;
            return vec![];
        }
        let body = EffectBody::LayoutSave(LayoutSave {
            current: self.document().to_string(),
            named_layouts: self.arrangements.to_text(),
        });
        let revision = self.arrangements.revision.clone();
        let sent = self.send_layout(body, LayoutOp::Save, revision);
        self.arrangements.saving = !sent.is_empty();
        sent
    }

    /// Emit an effect the root owns. It is held in the same bound as a
    /// panel's, and a refusal is told.
    fn send_layout(
        &mut self,
        body: EffectBody,
        op: LayoutOp,
        revision: Option<Revision>,
    ) -> Vec<Effect> {
        let id = self.ids.mint();
        let mut effect = Effect::new(id, crate::ids::ResourceRef::None, body);
        if let Some(revision) = revision {
            effect = effect.with_revision(revision);
        }
        if let Err(full) = self.in_flight.register(&effect) {
            self.counters.refused_full += 1;
            self.notify(Notice::EffectsFull { limit: full.limit });
            return vec![];
        }
        self.layout_pending.insert(id, op);
        vec![effect]
    }

    /// The answer to a layout effect the root sent. `None` when `completion`
    /// is not one.
    pub(crate) fn on_layout_completion(&mut self, completion: &Completion) -> Option<Vec<Effect>> {
        let op = self.layout_pending.remove(&completion.effect)?;
        let nobody = Binding {
            resource: crate::ids::ResourceRef::None,
            revision: None,
            generation: None,
        };
        if let Verdict::Drop(stale) = self.in_flight.settle(&nobody, completion) {
            self.counters.dropped += 1;
            self.counters.last_drop = Some(stale);
            return Some(vec![]);
        }
        self.counters.applied += 1;
        let mut effects = vec![];
        match (op, &completion.outcome, &completion.payload) {
            (LayoutOp::Load, Outcome::Accepted, Some(CompletionPayload::LayoutLoaded(loaded))) => {
                self.arrangements.revision = Some(loaded.revision.clone());
                if let Some(document) = &loaded.document {
                    self.read_record(&document.named_layouts, &document.current);
                }
            }
            (LayoutOp::Save, Outcome::Accepted, payload) => {
                self.arrangements.saving = false;
                if let Some(CompletionPayload::LayoutSaved(saved)) = payload {
                    self.arrangements.revision = Some(saved.revision.clone());
                }
                if std::mem::take(&mut self.arrangements.save_again) {
                    effects = self.save_arrangements();
                }
            }
            (op, outcome, _) => {
                if op == LayoutOp::Save {
                    self.arrangements.saving = false;
                    self.arrangements.save_again = false;
                }
                let reason = match outcome {
                    Outcome::Refused { reason, .. }
                    | Outcome::Failed { reason }
                    | Outcome::Uncertain { reason } => reason.clone(),
                    Outcome::Accepted => "The answer carried nothing to read.".into(),
                };
                self.notify(Notice::Arrangement(ArrangementNotice::NotSaved { reason }));
            }
        }
        Some(effects)
    }

    /// Take what the account holds: its arrangements, and the layout it was
    /// left in (applied the way an arrangement is, so what is open stays).
    fn read_record(&mut self, named: &str, current: &str) {
        match Arrangements::from_text(named) {
            Ok((items, skipped, caveat)) => {
                self.arrangements.items = items;
                if skipped > 0 || caveat.is_some() {
                    self.notify(Notice::Arrangement(ArrangementNotice::LoadedWithLoss {
                        skipped,
                        reason: caveat.unwrap_or_else(|| "Some entries could not be read.".into()),
                    }));
                }
            }
            Err(reason) => {
                self.arrangements.items.clear();
                self.notify(Notice::Arrangement(ArrangementNotice::LoadedWithLoss {
                    skipped: 0,
                    reason,
                }));
            }
        }
        if !current.trim().is_empty() {
            match serde_json::from_str::<Value>(current) {
                Ok(document) => self.apply("The saved layout", Target::Saved(document)),
                Err(e) => self.notify(Notice::Arrangement(ArrangementNotice::Unreadable {
                    name: "The saved layout".into(),
                    reason: e.to_string(),
                })),
            }
        }
    }

    /// Forget everything that belongs to the account before this one.
    pub(crate) fn forget_arrangements(&mut self) {
        self.arrangements = Arrangements::default();
        self.layout_pending.clear();
    }

    // --- applying ---

    fn live_panels(&self) -> Vec<Live> {
        let mut live = Vec::new();
        for group in self.dock.group_ids() {
            let Some(group) = self.dock.group(group) else {
                continue;
            };
            for tab in group.tabs() {
                let id = PanelInstanceId::new(tab.panel.0.clone());
                if self.panels.contains_key(&id) {
                    live.push(Live {
                        id,
                        kind: tab.kind.name.clone(),
                        role: group.role(),
                        tab: tab.clone(),
                    });
                }
            }
        }
        live
    }

    fn apply(&mut self, name: &str, target: Target) {
        let live = self.live_panels();
        let focused = self.focus_owner();
        let cfg = *self.dock.config();
        let mut caveats = Vec::new();
        let mut repairs = 0;
        let mut unavailable: Vec<String> = Vec::new();
        let mut claims: BTreeMap<PanelId, PanelInstanceId> = BTreeMap::new();
        let mut states: BTreeMap<PanelId, serde_json::Value> = BTreeMap::new();

        let mut dock = match target {
            Target::Preset(preset) => Dock::from_preset(cfg, preset).0,
            Target::Saved(document) => {
                let mut doc = match self.read_saved(&document, &mut caveats) {
                    Ok(doc) => doc,
                    Err(reason) => {
                        self.notify(Notice::Arrangement(ArrangementNotice::Unreadable {
                            name: name.to_owned(),
                            reason,
                        }));
                        return;
                    }
                };
                self.claim(&mut doc, &live, &mut claims, &mut states);
                let serves = |kind: &theorem_workbench_dock::PanelKind| {
                    self.unserved(&PanelKind::new(kind.name.as_str()), kind.version)
                        .is_none()
                };
                match Dock::restore(doc, cfg, serves) {
                    Ok((dock, report)) => {
                        repairs = report.repairs.len();
                        for panel in &report.unavailable {
                            if claims.contains_key(panel) {
                                continue;
                            }
                            if let Some(kind) = dock
                                .find_panel(panel)
                                .and_then(|g| dock.group(g))
                                .and_then(|g| g.tabs().iter().find(|t| &t.panel == panel))
                                .map(|t| t.kind.name.clone())
                                && !unavailable.contains(&kind)
                            {
                                unavailable.push(kind);
                            }
                        }
                        dock
                    }
                    Err(e) => {
                        self.notify(Notice::Arrangement(ArrangementNotice::Unreadable {
                            name: name.to_owned(),
                            reason: e.to_string(),
                        }));
                        return;
                    }
                }
            }
        };

        // Panels the arrangement does not name stay open, in the group of
        // their role or, when that is hidden here, the main one.
        let mut entries: BTreeMap<PanelInstanceId, Entry> = BTreeMap::new();
        let mut placed: Vec<PanelInstanceId> = Vec::new();
        for tab in group_tabs(&dock) {
            let id = PanelInstanceId::new(tab.panel.0.clone());
            let kind = PanelKind::new(tab.kind.name.as_str());
            let entry = match claims.get(&tab.panel).and_then(|l| self.panels.remove(l)) {
                Some(entry) => entry,
                None => {
                    let state = states.get(&tab.panel).cloned().unwrap_or_default();
                    let (panel, available) = self.build_panel(&kind, tab.kind.version, &state);
                    Entry {
                        panel,
                        kind,
                        available,
                        body: None,
                        workspace_seen: None,
                        replayed: None,
                    }
                }
            };
            placed.push(id.clone());
            entries.insert(id, entry);
        }
        for l in &live {
            if placed.contains(&l.id) {
                continue;
            }
            let at = visible_group(&dock, l.role);
            let mut tab = l.tab.clone();
            tab.panel = PanelId(l.id.as_str().to_owned());
            if let Some(group) = at {
                let _ = dock.open_panel(tab, OpenAt::Group(group));
            }
            if let Some(entry) = self.panels.remove(&l.id) {
                entries.insert(l.id.clone(), entry);
            }
        }
        if let Some(panel) = &focused
            && entries.contains_key(panel)
        {
            let _ = dock.focus_panel(&Self::dock_id(panel));
        }

        let has_picker = entries.values().any(|e| e.kind.as_str() == PICKER_KIND);
        self.dock = dock;
        self.panels = entries;
        self.drag = None;
        self.capture = None;
        self.announced_focus = None;
        self.sync_shortcuts();
        if has_picker && !self.picker.holds_keys() && !self.picker.is_resting() {
            self.picker.update(
                crate::picker::PickerMsg::Rest,
                &self.registry,
                &self.caps,
                &self.pinned,
            );
        }
        let notice = if caveats.is_empty() && unavailable.is_empty() && repairs == 0 {
            ArrangementNotice::Applied {
                name: name.to_owned(),
            }
        } else {
            ArrangementNotice::Partial {
                name: name.to_owned(),
                unavailable,
                repairs,
                caveats,
            }
        };
        self.notify(Notice::Arrangement(notice));
        self.dirty = true;
    }

    /// The dock document inside a saved layout, read as far as it can be.
    fn read_saved(
        &self,
        document: &Value,
        caveats: &mut Vec<String>,
    ) -> Result<DockDocument, String> {
        if document.get("schema").and_then(Value::as_str) != Some(DOCUMENT_SCHEMA) {
            return Err("it is not a workbench layout".into());
        }
        let version = document.get("version").and_then(Value::as_u64).unwrap_or(0);
        if version != u64::from(DOCUMENT_VERSION) {
            let which = if version > u64::from(DOCUMENT_VERSION) {
                "a newer"
            } else {
                "an older"
            };
            caveats.push(format!(
                "Saved by {which} version ({version}); read as far as this build can."
            ));
        }
        let mut doc: DockDocument =
            serde_json::from_value(document.get("dock").cloned().unwrap_or_default())
                .map_err(|e| format!("the layout could not be read: {e}"))?;
        if doc.version != theorem_workbench_dock::VERSION {
            caveats.push(format!(
                "The arrangement of groups was saved at version {}; this build reads {}.",
                doc.version,
                theorem_workbench_dock::VERSION
            ));
            doc.version = theorem_workbench_dock::VERSION;
        }
        Ok(doc)
    }

    /// Give each saved tab a live panel of its kind when there is one, and a
    /// fresh id when there is not, so nothing collides with what is open.
    fn claim(
        &mut self,
        doc: &mut DockDocument,
        live: &[Live],
        claims: &mut BTreeMap<PanelId, PanelInstanceId>,
        states: &mut BTreeMap<PanelId, Value>,
    ) {
        let mut free: Vec<&Live> = live.iter().collect();
        let saved: Vec<(PanelId, String)> = doc
            .groups
            .values()
            .flat_map(|g| {
                g.tabs
                    .iter()
                    .map(|t| (t.panel.clone(), t.kind.name.clone()))
            })
            .collect();
        let mut by_saved: BTreeMap<PanelId, PanelInstanceId> = BTreeMap::new();
        for same_id in [true, false] {
            for (panel, kind) in &saved {
                if by_saved.contains_key(panel) {
                    continue;
                }
                let at = free
                    .iter()
                    .position(|l| l.kind == *kind && (!same_id || l.id.as_str() == panel.0));
                if let Some(at) = at {
                    by_saved.insert(panel.clone(), free.remove(at).id.clone());
                }
            }
        }
        let mut rename: BTreeMap<PanelId, PanelId> = BTreeMap::new();
        let mut minted: Vec<String> = Vec::new();
        for (panel, _) in &saved {
            let new = match by_saved.get(panel) {
                Some(live) => PanelId(live.as_str().to_owned()),
                None => {
                    // Not one open, and not one already given out here.
                    let mut n = (self.panels.len() + minted.len()) as u64;
                    loop {
                        n += 1;
                        let fresh = format!("p{n}");
                        if !self
                            .panels
                            .contains_key(&PanelInstanceId::new(fresh.clone()))
                            && !minted.contains(&fresh)
                        {
                            minted.push(fresh.clone());
                            break PanelId(fresh);
                        }
                    }
                }
            };
            rename.insert(panel.clone(), new);
        }
        for group in doc.groups.values_mut() {
            for tab in &mut group.tabs {
                let new = rename[&tab.panel].clone();
                states.insert(new.clone(), std::mem::take(&mut tab.view_state));
                if let Some(live) = by_saved.get(&tab.panel) {
                    claims.insert(new.clone(), live.clone());
                }
                tab.panel = new;
            }
            if let Some(active) = &group.active {
                group.active = rename.get(active).cloned();
            }
        }
    }
}

fn group_tabs(dock: &Dock) -> Vec<Tab> {
    dock.group_ids()
        .into_iter()
        .filter_map(|g| dock.group(g))
        .flat_map(|g| g.tabs().to_vec())
        .collect()
}

/// A shown group of `role`, else the main one, else any shown.
fn visible_group(dock: &Dock, role: DockRole) -> Option<GroupId> {
    let shown = |want: Option<DockRole>| {
        dock.group_ids().into_iter().find(|id| {
            dock.group(*id)
                .is_some_and(|g| !g.is_hidden() && want.is_none_or(|r| g.role() == r))
        })
    };
    shown(Some(role))
        .or_else(|| shown(Some(DockRole::Main)))
        .or_else(|| shown(None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_message_is_plain_tagged_json_for_the_wasm_boundary() {
        let msg: ArrangementMsg =
            serde_json::from_value(json!({"type": "save", "name": "Writing"})).unwrap();
        assert_eq!(
            msg,
            ArrangementMsg::Save {
                name: "Writing".into()
            }
        );
        let rename = serde_json::to_value(ArrangementMsg::Rename {
            from: "a".into(),
            to: "b".into(),
        })
        .unwrap();
        assert_eq!(rename, json!({"type": "rename", "from": "a", "to": "b"}));
    }

    #[test]
    fn a_record_with_unreadable_entries_keeps_the_rest_and_counts_the_loss() {
        let text = json!({
            "schema": ARRANGEMENTS_SCHEMA, "version": 2,
            "items": [
                {"name": "ok", "document": {"a": 1}},
                {"name": "", "document": {"a": 1}},
                {"name": "no document"},
                {"name": "OK", "document": {"a": 2}},
            ]
        })
        .to_string();
        let (items, skipped, caveat) = Arrangements::from_text(&text).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(skipped, 3);
        assert!(caveat.unwrap().contains("version 2"));
        assert!(Arrangements::from_text("{\"schema\": \"x\"}").is_err());
        assert!(Arrangements::from_text("").unwrap().0.is_empty());
    }
}
