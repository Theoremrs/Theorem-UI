//! Alternate presentations of a document (R48, AC-59).
//!
//! A presentation is a registered panel kind that the registry declares can
//! show a kind of resource (see [`crate::registry::Presentation`]). Showing a
//! document another way swaps the panel in its tab: the instance id, the tab's
//! place and group, the focus and the binding stay, and the old panel is
//! released the way a kind change releases it (a close that destroys nothing).
//!
//! A swap is refused while the outgoing panel holds work that is not settled
//! (unsaved edits, an effect still in flight for the document). The editor and
//! the Markdown panel keep their drafts in stores of their own, so there is no
//! shared serialised session to hand over, and refusing cannot lose an edit.
//! The new panel is built from the document's identity alone and loads on its
//! first tick, as any panel of its kind does when it is opened.
//!
//! Nothing here loads code or reads a location: the kinds are the ones the
//! root registered, and the capabilities are the host's.

use serde_json::{Value, json};

use crate::effect::{Effect, EffectKind};
use crate::ids::{ActionId, PanelInstanceId, PanelKind, ResourceRef};
use crate::model::{Entry, Model, Notice};
use crate::panel::Mode;
use crate::picker::PickerMsg;
use crate::registry::{ActionIntent, Availability, PickerRow, PresentationEntry, Refusal};

/// Opens the chooser of presentations for the panel's document.
pub const ACTION_PRESENTATION: &str = "panel.presentation";
/// Swaps to the next available presentation.
pub const ACTION_PRESENTATION_NEXT: &str = "panel.presentation.next";
/// Swaps to the presentation whose kind follows. Not a registry entry: one
/// per listed presentation, offered on the panel's node and the chooser's rows.
pub const PRESENTATION_USE: &str = "panel.presentation.use:";

/// The mark on the chooser's row for the way the panel shows the document now.
const CURRENT_MARK: &str = "\u{25cf}";

/// The document a saved panel state names, by the `{workspace, path}` every
/// document panel is opened from (`OpenTarget::File`).
pub(crate) fn document_of_state(state: &Value) -> Option<ResourceRef> {
    let workspace = state.get("workspace")?.as_str()?;
    let path = state.get("path")?.as_str()?;
    if state.get("revision").is_some() || path.is_empty() {
        return None;
    }
    Some(ResourceRef::Document {
        workspace: workspace.to_owned(),
        resource_id: path.to_owned(),
    })
}

impl Model {
    /// The document panel `id` shows, or (for a placeholder that kept a
    /// document's state) the one it keeps.
    fn presented_resource(&self, id: &PanelInstanceId) -> Option<ResourceRef> {
        let entry = self.panels.get(id)?;
        let resource = if entry.available {
            entry.binding().resource
        } else {
            document_of_state(&entry.panel.serialize())?
        };
        (resource != ResourceRef::None).then_some(resource)
    }

    /// The ways panel `id` can show its document, the default first. One the
    /// host has not granted, or this build has no constructor for, is listed
    /// unavailable with the reason; the one showing now is `current`. Empty
    /// for a panel that is not bound to a document anything else can show.
    pub fn presentations_of(&self, id: &PanelInstanceId) -> Vec<PresentationEntry> {
        let Some(resource) = self.presented_resource(id) else {
            return vec![];
        };
        let current = self
            .panels
            .get(id)
            .filter(|e| e.available)
            .map(|e| e.kind.clone());
        self.registry
            .presentations_for(&resource, &self.caps)
            .into_iter()
            .map(|mut e| {
                e.current = current.as_ref() == Some(&e.kind);
                if e.availability.is_available() && !self.factories.has(&e.kind) {
                    e.availability = Availability::Unavailable {
                        reason: format!(
                            "No constructor is registered for \"{}\".",
                            e.kind.as_str()
                        ),
                    };
                }
                e
            })
            .collect()
    }

    fn refuse(&mut self, reason: impl Into<String>) -> Vec<Effect> {
        self.notify(Notice::Refused(Refusal::Unavailable {
            reason: reason.into(),
        }));
        vec![]
    }

    /// The panel a presentation action is for: the one named, else the one
    /// holding the keyboard.
    fn presentation_target_of(&mut self, on: Option<PanelInstanceId>) -> Option<PanelInstanceId> {
        on.or_else(|| self.presentation_target.clone())
            .or_else(|| {
                self.focus_owner()
                    .filter(|id| !self.is_picker_panel(id))
                    .or_else(|| self.before_picker.clone())
            })
            .filter(|id| self.panels.contains_key(id))
    }

    /// `panel.presentation` and `panel.presentation.next`.
    pub(crate) fn presentation_action(
        &mut self,
        action: &str,
        on: Option<PanelInstanceId>,
    ) -> Vec<Effect> {
        let Some(id) = self.presentation_target_of(on) else {
            return self.refuse("Focus a panel that shows a document first.");
        };
        let entries = self.presentations_of(&id);
        if entries.is_empty() {
            return self
                .refuse("This panel is not showing a document that can be shown another way.");
        }
        if action == ACTION_PRESENTATION_NEXT {
            let n = entries.len();
            let start = entries
                .iter()
                .position(|e| e.current)
                .map_or(0, |at| at + 1);
            let next = (0..n)
                .map(|i| &entries[(start + i) % n])
                .find(|e| !e.current && e.availability.is_available());
            return match next {
                Some(e) => self.swap_presentation(&id, &e.kind.clone()),
                None => self.refuse("No other presentation can show this document."),
            };
        }
        // The chooser: the same picker the layouts use, on its own page.
        self.presentation_target = Some(id);
        let rows = entries.iter().map(presentation_row).collect();
        let _ = self.picker_msg(PickerMsg::Open);
        self.picker.set_presentations(rows);
        self.picker_msg(PickerMsg::Presentations)
    }

    /// `panel.presentation.use:<kind>`, from the chooser or aimed at a panel.
    pub(crate) fn use_presentation(
        &mut self,
        kind: &PanelKind,
        on: Option<PanelInstanceId>,
    ) -> Vec<Effect> {
        let Some(id) = self.presentation_target_of(on) else {
            return self.refuse("Focus a panel that shows a document first.");
        };
        self.presentation_target = None;
        let entries = self.presentations_of(&id);
        let effects = match entries.iter().find(|e| &e.kind == kind) {
            None => self.refuse(format!("\"{}\" cannot show this document.", kind.as_str())),
            Some(e) => match &e.availability {
                Availability::Unavailable { reason } => self.refuse(reason.clone()),
                Availability::Available => self.swap_presentation(&id, kind),
            },
        };
        if self.picker.page() == crate::picker::Page::Presentations {
            let more = self.picker_msg(PickerMsg::Close);
            debug_assert!(more.is_empty());
        }
        effects
    }

    /// Swap panel `id` to presentation `to`, in place. The caller has checked
    /// that `to` is listed and available for the panel's document.
    pub(crate) fn swap_presentation(
        &mut self,
        id: &PanelInstanceId,
        to: &PanelKind,
    ) -> Vec<Effect> {
        let Some(resource) = self.presented_resource(id) else {
            return self.refuse("This panel is not showing a document.");
        };
        let Some(entry) = self.panels.get(id) else {
            return vec![];
        };
        if entry.available && &entry.kind == to {
            return vec![];
        }
        // Work that is not settled stays where it is.
        if entry.available && entry.panel.tab_label().is_some_and(|l| l.modified) {
            return self.refuse(
                "This panel has changes that are not saved. Save or discard them before showing the document another way.",
            );
        }
        // A release a swap sent itself (the close) is not work the panel holds.
        let busy = self.in_flight.pending_for(&resource).any(|(effect, p)| {
            p.kind != EffectKind::DocumentClose && self.origins.get(effect) == Some(id)
        });
        if busy {
            return self.refuse(
                "This panel is still waiting on the document. Try again when it has settled.",
            );
        }
        let Some(desc) = self.registry.get(to) else {
            return self.refuse(format!("This build has no panel \"{}\".", to.as_str()));
        };
        let (title, version) = (desc.title.clone(), desc.version);
        // Opened as any panel of its kind is: from the document's identity.
        let ResourceRef::Document {
            workspace,
            resource_id,
        } = &resource
        else {
            return self.refuse("Only a document can be shown another way.");
        };
        let state = json!({ "workspace": workspace, "path": resource_id });
        let (panel, available) = self.build_panel(to, version, &state);
        if !available {
            return self.refuse(format!(
                "\"{}\" is not available in this build.",
                to.as_str()
            ));
        }

        // The old panel is released as on a kind change: its view closes and
        // nothing is destroyed.
        let Some(mut old) = self.panels.remove(id) else {
            return vec![];
        };
        let mode = Mode::Forbid(self.destroying.clone());
        let out = self.run_ctx(id, mode, |cx| old.panel.teardown(cx, false));
        self.origins.retain(|e, _| self.in_flight.is_pending(*e));
        self.searches.retain(|_, panel| panel != id);
        self.panels.insert(
            id.clone(),
            Entry {
                panel,
                kind: to.clone(),
                available: true,
                body: None,
                workspace_seen: None,
                replayed: None,
            },
        );
        let _ = self.dock.set_tab_kind(
            &Self::dock_id(id),
            theorem_workbench_dock::PanelKind::new(to.as_str(), version),
            &title,
        );
        // The new panel is told it owns the keyboard, if it does.
        if self.announced_focus.as_ref() == Some(id) {
            self.announced_focus = None;
        }
        self.dirty = true;
        out.effects
    }
}

fn presentation_row(entry: &PresentationEntry) -> PickerRow {
    PickerRow {
        action: ActionId::new(format!("{PRESENTATION_USE}{}", entry.kind.as_str())),
        panel: entry.kind.clone(),
        title: entry.title.clone(),
        intent: ActionIntent::Open,
        availability: entry.availability.clone(),
        pinned: false,
        chooses: crate::registry::Chooses::Opens,
        pinnable: false,
        shortcut: None,
        glyph: entry.current.then(|| CURRENT_MARK.to_owned()),
    }
}
