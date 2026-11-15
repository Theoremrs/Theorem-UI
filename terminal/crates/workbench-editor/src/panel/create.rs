//! Naming a new page and creating it through the document owner.
//!
//! The `New page` row only opens an editor with no file; nothing exists until
//! the name is confirmed. An editor with no file offers the prompt in place
//! of its text and becomes the new document when the owner accepts. An editor
//! that already shows a file (the `page.create` action reached it) asks in its
//! strip and, when the owner accepts, opens the new file in an editor of its
//! own and gives back the hold the create took.

use keybinds::KeyInput;
use theorem_workbench_core::completion::{Completion, CompletionPayload, Outcome};
use theorem_workbench_core::effect::{DocumentCreate, EffectBody};
use theorem_workbench_core::ids::ResourceRef;
use theorem_workbench_core::{Ctx, OpenTarget};

use super::flow::emit_notice;
use super::{EditorPanel, Phase, Task, Tone};
use crate::field::{self, Event, Field};

/// The name being typed, and what the owner said to the last one.
#[derive(Debug, Default)]
pub(crate) struct Naming {
    pub field: Field,
    pub error: Option<String>,
    /// A create is in flight: the name is not editable and not sent twice.
    pub busy: bool,
    /// This editor has no file and becomes the new one; otherwise the new
    /// file opens in an editor of its own.
    pub adopt: bool,
}

impl EditorPanel {
    /// The prompt in an editor with no file.
    pub(super) fn naming_idle(&self) -> bool {
        self.naming.as_ref().is_some_and(|n| n.adopt) && !matches!(self.phase, Phase::Ready(_))
    }

    /// `page.create` reached an editor that shows a file: ask for the name in
    /// its strip.
    pub(super) fn begin_naming(&mut self) {
        let adopt = !matches!(self.phase, Phase::Ready(_));
        if self.naming.is_none() {
            self.naming = Some(Naming {
                adopt,
                ..Naming::default()
            });
        }
    }

    /// A key while the name is being typed. True when the prompt took it.
    pub(super) fn naming_key(&mut self, key: &KeyInput, cx: &mut Ctx) -> bool {
        let event = {
            let Some(n) = self.naming.as_mut() else {
                return false;
            };
            if n.busy {
                return true;
            }
            field::press(&mut n.field, key)
        };
        match event {
            Event::Enter => self.submit_naming(cx),
            Event::Escape => {
                let adopt = self.naming.as_ref().is_some_and(|n| n.adopt);
                let had_error = self.naming.as_ref().is_some_and(|n| n.error.is_some());
                if adopt && !had_error {
                    cx.close_self();
                } else if adopt {
                    if let Some(n) = self.naming.as_mut() {
                        n.error = None;
                    }
                } else {
                    self.naming = None;
                }
            }
            Event::Edited => {
                if let Some(n) = self.naming.as_mut() {
                    n.error = None;
                }
            }
            Event::Clipboard(what) => self.field_clipboard(what, cx),
            Event::Ignored => {}
        }
        true
    }

    pub(super) fn naming_text(&mut self, text: &str) -> bool {
        let Some(n) = self.naming.as_mut() else {
            return false;
        };
        if !n.busy {
            field::typed(&mut n.field, text.lines().next().unwrap_or(""));
            n.error = None;
        }
        true
    }

    /// Send the create for the name typed.
    pub(super) fn submit_naming(&mut self, cx: &mut Ctx) {
        let Some(n) = self.naming.as_mut() else {
            self.begin_naming();
            return;
        };
        if n.busy {
            return;
        }
        let name = n.field.value().trim().to_owned();
        let adopt = n.adopt;
        let refuse = if name.is_empty() {
            Some("Name the page first.".to_owned())
        } else if !self.documents {
            Some("The document service is not available in this workspace.".to_owned())
        } else if !self.identity.is_set() {
            Some("Waiting for the workspace.".to_owned())
        } else {
            None
        };
        if let Some(why) = refuse {
            if let Some(n) = self.naming.as_mut() {
                n.error = Some(why);
            }
            return;
        }
        let workspace = self.workspace.clone();
        let resource = ResourceRef::Document {
            workspace,
            resource_id: name.clone(),
        };
        // An editor with no file is bound to the new one for the answer to
        // find it, and unbinds again if the owner says no.
        if adopt {
            self.path = name.clone();
        }
        let body = EffectBody::DocumentCreate(DocumentCreate {
            path: name.clone(),
            seed_text: None,
        });
        match self.emit(cx, resource, body, None) {
            Ok(id) => {
                self.outstanding
                    .insert(id, Task::Create { path: name, adopt });
                if adopt {
                    self.phase = Phase::Opening;
                }
                if let Some(n) = self.naming.as_mut() {
                    n.busy = true;
                    n.error = None;
                }
            }
            Err(e) => {
                if adopt {
                    self.path.clear();
                }
                if let Some(n) = self.naming.as_mut() {
                    n.error = Some(emit_notice(e));
                }
            }
        }
    }

    /// The owner's answer to a create.
    pub(super) fn on_create(&mut self, path: String, adopt: bool, mut c: Completion, cx: &mut Ctx) {
        match (&c.outcome, c.payload.take()) {
            (Outcome::Accepted, Some(CompletionPayload::DocumentOpened(opened))) => {
                self.naming = None;
                if adopt {
                    if self.path != path {
                        return;
                    }
                    c.payload = Some(CompletionPayload::DocumentOpened(opened));
                    self.on_open(c, cx);
                } else {
                    cx.open(OpenTarget::File {
                        workspace: self.workspace.clone(),
                        path: path.clone(),
                    });
                    // The create holds the document for this editor, which has
                    // no use for it: give it back, the new editor opens its own.
                    let resource = ResourceRef::Document {
                        workspace: self.workspace.clone(),
                        resource_id: path.clone(),
                    };
                    if let Ok(id) = self.emit(cx, resource, EffectBody::DocumentClose, None) {
                        self.outstanding.insert(id, Task::Release);
                    }
                    self.say(format!("Created {path}."), Tone::Info);
                }
            }
            (Outcome::Accepted, _) => {
                // Created, with no document in the answer: it opens the
                // ordinary way.
                self.naming = None;
                if adopt {
                    self.phase = Phase::Waiting;
                } else {
                    cx.open(OpenTarget::File {
                        workspace: self.workspace.clone(),
                        path,
                    });
                }
            }
            (outcome, _) => {
                let why = match outcome {
                    Outcome::Refused { code, reason } => format!("{reason} ({code})"),
                    Outcome::Failed { reason } => reason.clone(),
                    Outcome::Uncertain { reason } => format!(
                        "Unknown whether {path} was created: {reason} Enter asks again; look in Files first if it matters."
                    ),
                    Outcome::Accepted => String::new(),
                };
                if adopt {
                    self.path.clear();
                    self.phase = Phase::Waiting;
                }
                if let Some(n) = self.naming.as_mut() {
                    n.busy = false;
                    n.error = Some(why);
                }
            }
        }
    }
}
