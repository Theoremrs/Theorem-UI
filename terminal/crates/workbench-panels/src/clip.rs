//! The clipboard route of a text field, for the panels that have no clipboard of their own.
//!
//! A field's copy and cut keys ([`Keyed::Copy`], [`Keyed::Cut`]) go out as the host-owned
//! `ClipboardWrite` effect, the one the composer and the editor send. A cut takes the text out
//! only once the host accepted the write, so a refusal leaves the field as it was.
//!
//! The panel keeps one [`FieldClip`], asks it on the key, offers it each completion before its
//! own, and acts on what it [settles](FieldClip::settle): a copy needs nothing, a cut deletes
//! the selection if the field still holds those very characters, and a refusal is worded for
//! the panel's own place to say it.

use std::collections::BTreeMap;

use theorem_workbench_core::Ctx;
use theorem_workbench_core::completion::{Completion, Outcome};
use theorem_workbench_core::effect::{ClipboardWrite, Effect, EffectBody};
use theorem_workbench_core::ids::{EffectId, ResourceRef};
use theorem_workbench_text::field::{Field, Keyed};

/// The clipboard writes a panel has out. `S` names the field a write came from (which of a
/// panel's fields had the selection), so a cut deletes from that one and no other.
#[derive(Debug)]
pub struct FieldClip<S> {
    /// For a cut, the text that was written.
    waiting: BTreeMap<EffectId, (S, Option<String>)>,
}

impl<S> Default for FieldClip<S> {
    fn default() -> Self {
        Self {
            waiting: BTreeMap::new(),
        }
    }
}

/// How a write ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Settled<S> {
    /// The clipboard has the text; nothing else changes.
    Copied,
    /// The clipboard has the text: take it out of field `S` if that field still holds it.
    Cut(S, String),
    /// The write did not take: the outcome, and whether it was a cut.
    Not { cut: bool, outcome: Outcome },
}

impl<S: Copy> FieldClip<S> {
    /// A copy or a cut key in field `slot`: sends the write of the selection. Returns what to
    /// say when it could not be sent; any other outcome of the key is not the clipboard's.
    pub fn ask(&mut self, cx: &mut Ctx, slot: S, keyed: Keyed, field: &Field) -> Option<String> {
        let cut = match keyed {
            Keyed::Copy => false,
            Keyed::Cut => true,
            _ => return None,
        };
        let text = field.selected_text()?;
        let body = EffectBody::ClipboardWrite(ClipboardWrite { text: text.clone() });
        match cx.emit(|id| Effect::new(id, ResourceRef::None, body)) {
            Ok(id) => {
                self.waiting.insert(id, (slot, cut.then_some(text)));
                None
            }
            Err(error) => Some(format!(
                "Not {}: {error}",
                if cut { "cut" } else { "copied" }
            )),
        }
    }

    /// The end of a write this panel sent; `None` for any other completion.
    pub fn settle(&mut self, completion: &Completion) -> Option<Settled<S>> {
        let (slot, written) = self.waiting.remove(&completion.effect)?;
        let cut = written.is_some();
        Some(match (&completion.outcome, written) {
            (Outcome::Accepted, Some(text)) => Settled::Cut(slot, text),
            (Outcome::Accepted, None) => Settled::Copied,
            (outcome, _) => Settled::Not {
                cut,
                outcome: outcome.clone(),
            },
        })
    }
}

/// The words for a write that did not take, as the editor words them.
pub fn not_done(cut: bool, outcome: &Outcome) -> String {
    match outcome {
        Outcome::Accepted => String::new(),
        Outcome::Uncertain { reason } => {
            format!("Unknown whether the clipboard took it: {reason}")
        }
        Outcome::Refused { reason, .. } | Outcome::Failed { reason } => {
            format!("{}: {reason}", if cut { "Not cut" } else { "Not copied" })
        }
    }
}

/// Takes the selected text out of `field` if it is still `text`: the second half of a cut.
pub fn finish_cut(field: &mut Field, text: &str) -> bool {
    field.selected_text().as_deref() == Some(text) && field.delete_selection()
}
