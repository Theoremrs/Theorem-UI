//! The staleness gate. A panel asks it what to do with a completion; it never
//! decides from the completion alone, because a completion can only be
//! judged against what the pane is bound to now (spec 6, R33).

use std::cmp::Ordering;
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::completion::{Completion, Outcome};
use crate::effect::{Effect, EffectKind};
use crate::ids::{EffectId, Generation, ResourceRef, Revision};

/// What a pane is bound to right now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub resource: ResourceRef,
    pub revision: Option<Revision>,
    pub generation: Option<Generation>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Stale {
    /// No effect with this id is in flight: never sent, or already settled.
    UnknownEffect,
    /// The completion names a different resource than its effect did.
    ResourceChanged,
    /// The pane is no longer bound to the resource, and the completion has
    /// nothing worth keeping.
    NotBound,
    /// Older revision than the pane's.
    OlderRevision,
    /// The owner reported a different opaque revision: nothing says which is
    /// newer, so the pane re-reads instead of applying.
    UnorderedRevision,
    /// Older generation than the pane's.
    OlderGeneration,
    /// A terminal frame of an older binding epoch than the pane's: its offsets
    /// belong to a binding that is gone.
    OlderEpoch,
    /// A host frame whose payload could not be decoded.
    MalformedFrame,
}

/// What to do with a completion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Fold it into the pane.
    Apply,
    /// The pane moved on, but the result is still true of its resource: keep
    /// it in the cache keyed by the completion's resource, and do not apply.
    /// An uncertain outcome lands here too, so reopening the resource shows it
    /// as unknown rather than forgetting it.
    CacheOnly,
    Drop(Stale),
}

fn keeps_result(outcome: &Outcome) -> bool {
    matches!(outcome, Outcome::Accepted | Outcome::Uncertain { .. })
}

/// Judge a completion against the pane's binding. The completion is a final
/// outcome for its effect; an effect still in flight is checked by [`InFlight`].
pub fn judge(binding: &Binding, completion: &Completion) -> Verdict {
    if completion.resource != binding.resource {
        return if keeps_result(&completion.outcome) {
            Verdict::CacheOnly
        } else {
            Verdict::Drop(Stale::NotBound)
        };
    }
    if let (Some(done), Some(now)) = (completion.generation, binding.generation)
        && done < now
    {
        return Verdict::Drop(Stale::OlderGeneration);
    }
    if let (Some(done), Some(now)) = (&completion.revision, &binding.revision) {
        match done.order(now) {
            Some(Ordering::Less) => return Verdict::Drop(Stale::OlderRevision),
            Some(_) => {}
            None => return Verdict::Drop(Stale::UnorderedRevision),
        }
    }
    Verdict::Apply
}

/// An effect that has been sent and not yet answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pending {
    pub kind: EffectKind,
    pub resource: ResourceRef,
}

/// The tracker is at its bound. The effect was not recorded and must not be
/// sent: the caller shows the action as refused, never drops an older effect.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InFlightFull {
    pub limit: usize,
}

/// Effects in flight, keyed by id, with a fixed bound (R41).
#[derive(Debug)]
pub struct InFlight {
    limit: usize,
    pending: BTreeMap<EffectId, Pending>,
}

impl InFlight {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            pending: BTreeMap::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Record an effect before it is sent. A repeat of an id already in flight
    /// is a retry of the same operation and takes no extra room.
    pub fn register(&mut self, effect: &Effect) -> Result<(), InFlightFull> {
        if !self.pending.contains_key(&effect.id) && self.pending.len() >= self.limit {
            return Err(InFlightFull { limit: self.limit });
        }
        self.pending.insert(
            effect.id,
            Pending {
                kind: effect.kind(),
                resource: effect.resource.clone(),
            },
        );
        Ok(())
    }

    pub fn is_pending(&self, id: EffectId) -> bool {
        self.pending.contains_key(&id)
    }

    /// Settle a completion: the effect leaves the tracker, and the verdict is
    /// the staleness judgment against `binding`. A second completion for the
    /// same effect finds nothing and is dropped.
    pub fn settle(&mut self, binding: &Binding, completion: &Completion) -> Verdict {
        let Some(pending) = self.pending.remove(&completion.effect) else {
            return Verdict::Drop(Stale::UnknownEffect);
        };
        if pending.resource != completion.resource {
            return Verdict::Drop(Stale::ResourceChanged);
        }
        judge(binding, completion)
    }

    /// Effects still in flight against a resource, for "uncertain on close":
    /// a pane that goes away asks what it left behind.
    pub fn pending_for<'a>(
        &'a self,
        resource: &'a ResourceRef,
    ) -> impl Iterator<Item = (&'a EffectId, &'a Pending)> {
        self.pending
            .iter()
            .filter(move |(_, p)| &p.resource == resource)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effect::EffectBody;

    fn doc(path: &str) -> ResourceRef {
        ResourceRef::Document {
            workspace: "w".into(),
            resource_id: path.into(),
        }
    }

    fn binding(path: &str, rev: u64, gen_: u64) -> Binding {
        Binding {
            resource: doc(path),
            revision: Some(Revision::Seq(rev)),
            generation: Some(Generation(gen_)),
        }
    }

    fn accepted(id: u64, path: &str, rev: u64, gen_: u64) -> Completion {
        Completion::new(EffectId(id), doc(path), Outcome::Accepted)
            .with_revision(Revision::Seq(rev))
            .with_generation(Generation(gen_))
    }

    #[test]
    fn current_completion_applies() {
        assert_eq!(
            judge(&binding("a.md", 5, 1), &accepted(1, "a.md", 5, 1)),
            Verdict::Apply
        );
        // An acknowledgement that advances the baseline is newer, so it applies.
        assert_eq!(
            judge(&binding("a.md", 5, 1), &accepted(1, "a.md", 6, 1)),
            Verdict::Apply
        );
    }

    #[test]
    fn rebound_pane_caches_without_applying() {
        let verdict = judge(&binding("b.md", 1, 2), &accepted(1, "a.md", 5, 1));
        assert_eq!(verdict, Verdict::CacheOnly);
    }

    #[test]
    fn rebound_pane_drops_a_failure_but_keeps_uncertainty() {
        let b = binding("b.md", 1, 2);
        let failed = Completion::new(
            EffectId(1),
            doc("a.md"),
            Outcome::Failed { reason: "x".into() },
        );
        let unsure = Completion::new(
            EffectId(1),
            doc("a.md"),
            Outcome::Uncertain { reason: "x".into() },
        );
        assert_eq!(judge(&b, &failed), Verdict::Drop(Stale::NotBound));
        assert_eq!(judge(&b, &unsure), Verdict::CacheOnly);
    }

    #[test]
    fn older_revision_and_generation_are_dropped() {
        assert_eq!(
            judge(&binding("a.md", 8, 1), &accepted(1, "a.md", 7, 1)),
            Verdict::Drop(Stale::OlderRevision)
        );
        assert_eq!(
            judge(&binding("a.md", 8, 3), &accepted(1, "a.md", 8, 2)),
            Verdict::Drop(Stale::OlderGeneration)
        );
    }

    #[test]
    fn opaque_revisions_that_differ_are_not_applied() {
        let bound = Binding {
            resource: doc("a.md"),
            revision: Some(Revision::Opaque("r1".into())),
            generation: None,
        };
        let done = Completion::new(EffectId(1), doc("a.md"), Outcome::Accepted)
            .with_revision(Revision::Opaque("r2".into()));
        assert_eq!(
            judge(&bound, &done),
            Verdict::Drop(Stale::UnorderedRevision)
        );
        let same = done.with_revision(Revision::Opaque("r1".into()));
        assert_eq!(judge(&bound, &same), Verdict::Apply);
    }

    #[test]
    fn without_stamps_there_is_nothing_to_compare() {
        let bound = Binding {
            resource: doc("a.md"),
            revision: None,
            generation: None,
        };
        let done = Completion::new(EffectId(1), doc("a.md"), Outcome::Accepted);
        assert_eq!(judge(&bound, &done), Verdict::Apply);
    }

    #[test]
    fn late_ack_for_generation_seven_cannot_replace_eight() {
        // AC-15: generation 8 is pending; the acknowledgement for 7 arrives.
        let bound = binding("a.md", 4, 8);
        assert_eq!(
            judge(&bound, &accepted(1, "a.md", 4, 7)),
            Verdict::Drop(Stale::OlderGeneration)
        );
    }

    fn save(id: u64, path: &str) -> Effect {
        Effect::new(EffectId(id), doc(path), EffectBody::DocumentSave)
    }

    #[test]
    fn settling_removes_the_effect_and_a_repeat_is_unknown() {
        let mut flight = InFlight::new(4);
        flight.register(&save(1, "a.md")).unwrap();
        let b = binding("a.md", 5, 1);
        assert_eq!(
            flight.settle(&b, &accepted(1, "a.md", 5, 1)),
            Verdict::Apply
        );
        assert!(flight.is_empty());
        assert_eq!(
            flight.settle(&b, &accepted(1, "a.md", 5, 1)),
            Verdict::Drop(Stale::UnknownEffect)
        );
        assert_eq!(
            flight.settle(&b, &accepted(99, "a.md", 5, 1)),
            Verdict::Drop(Stale::UnknownEffect)
        );
    }

    #[test]
    fn a_completion_cannot_move_its_effect_to_another_resource() {
        let mut flight = InFlight::new(4);
        flight.register(&save(1, "a.md")).unwrap();
        let verdict = flight.settle(&binding("b.md", 1, 1), &accepted(1, "b.md", 1, 1));
        assert_eq!(verdict, Verdict::Drop(Stale::ResourceChanged));
    }

    #[test]
    fn the_bound_is_explicit_and_nothing_is_evicted() {
        let mut flight = InFlight::new(2);
        flight.register(&save(1, "a.md")).unwrap();
        flight.register(&save(2, "a.md")).unwrap();
        assert_eq!(
            flight.register(&save(3, "a.md")),
            Err(InFlightFull { limit: 2 })
        );
        assert!(flight.is_pending(EffectId(1)) && flight.is_pending(EffectId(2)));
        assert!(!flight.is_pending(EffectId(3)));
        // A retry of an id already in flight is not a new slot.
        assert_eq!(flight.register(&save(1, "a.md")), Ok(()));
        assert_eq!(flight.len(), 2);
    }

    #[test]
    fn a_closing_pane_can_list_what_it_left_in_flight() {
        let mut flight = InFlight::new(4);
        flight.register(&save(1, "a.md")).unwrap();
        flight.register(&save(2, "b.md")).unwrap();
        let left: Vec<_> = flight
            .pending_for(&doc("a.md"))
            .map(|(id, _)| *id)
            .collect();
        assert_eq!(left, vec![EffectId(1)]);
    }
}
