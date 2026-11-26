//! Who may type into a terminal on an agent's behalf (companion spec IN-02,
//! IN-03 and API-05, as Gate 0 decision 1 settled them).
//!
//! There is no lease between views: every view of the person's own may type,
//! paste and resize (R28), and nothing here stops them. What this table
//! arbitrates is agent input. An agent run types into a terminal only while
//! it holds a claim this table issued for that terminal's binding epoch. The
//! person's own input (a key, typed text or a paste in any view of the
//! terminal) takes control: the agent's claim ends and no agent may claim
//! the terminal again until the person hands it back. A claim also ends when
//! the page says its run finished, when the agent releases it,
//! or when the host rebinds the terminal (a new epoch). Nothing expires on a
//! timer.
//!
//! The table is shared by the panes one `register` call builds, so two views
//! of the same terminal see one answer. It is the workbench's arbitration at
//! the boundary where agent input enters; it is not a host-side fence, so a
//! second page with its own workbench keeps its own table.

use std::collections::{BTreeMap, BTreeSet};

/// One terminal, as the host names it.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Key {
    pub workspace: String,
    pub session: String,
}

/// The agent claim the table issued.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Claim {
    pub run: String,
    /// The binding epoch the claim was issued for. A rebind fences it.
    pub epoch: u64,
    /// Issued by the table, never by the caller. Increases across the table.
    pub id: u64,
}

/// Who holds a terminal's agent input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Holder {
    /// An agent run holds a claim.
    Agent(Claim),
    /// The person typed while an agent held it, and has not handed it back.
    /// `from` is the run whose claim the person's input ended. A rebind
    /// (a newer `epoch`) ends the takeover with the binding it was made on.
    Person { from: String, epoch: u64 },
}

/// Why an agent may not type now. The text is what the agent is told.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// No claim: the agent has to ask for one first.
    NoClaim,
    /// Another run holds it.
    HeldBy(String),
    /// The person took over and has not handed it back.
    Person,
    /// The claim was for an older binding of this terminal.
    Stale,
    /// The page said the run finished.
    Ended,
}

impl Refusal {
    pub(crate) fn text(&self) -> String {
        match self {
            Self::NoClaim => "This run holds no input claim on this terminal. Ask for one with \
                 code.claim before sending input."
                .into(),
            Self::HeldBy(run) => format!(
                "Agent run {run} holds this terminal's input claim. Only one agent types into a \
                 terminal at a time."
            ),
            Self::Person => "The person has taken over this terminal. Agent input stays stopped \
                 until they hand it back; tell them what you need instead."
                .into(),
            Self::Stale => "This run's input claim was for an earlier binding of this terminal. \
                 Ask for a new one with code.claim before sending more input."
                .into(),
            Self::Ended => "This run is no longer working, so it can take no input claim.".into(),
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct Control {
    held: BTreeMap<Key, Holder>,
    next: u64,
    /// Runs the page said finished: they claim nothing more. A run the page
    /// never saw finish (one in a chat no longer on screen) keeps its claim
    /// until it is released, the person takes over, or the terminal is
    /// rebound.
    ended: BTreeSet<String>,
}

impl Control {
    /// Issue `run` a claim on `key` at `epoch`. A run that already holds a
    /// claim for this epoch gets the same one back.
    pub(crate) fn claim(&mut self, key: Key, run: &str, epoch: u64) -> Result<Claim, Refusal> {
        if self.ended.contains(run) {
            return Err(Refusal::Ended);
        }
        self.fence_person(&key, epoch);
        match self.held.get(&key) {
            Some(Holder::Person { .. }) => return Err(Refusal::Person),
            Some(Holder::Agent(c)) if c.run == run && c.epoch == epoch => return Ok(c.clone()),
            Some(Holder::Agent(c)) if c.run != run && c.epoch == epoch => {
                return Err(Refusal::HeldBy(c.run.clone()));
            }
            // The request comes from a view of an older binding than the
            // claim held: it is the request that is stale, not the claim.
            Some(Holder::Agent(c)) if c.epoch > epoch => return Err(Refusal::Stale),
            // A claim for an older epoch is fenced: anyone may claim anew.
            _ => {}
        }
        self.next += 1;
        let claim = Claim {
            run: run.to_owned(),
            epoch,
            id: self.next,
        };
        self.held.insert(key, Holder::Agent(claim.clone()));
        Ok(claim)
    }

    /// Whether `run` may send input to `key` at `epoch` now.
    pub(crate) fn check(&mut self, key: &Key, run: &str, epoch: u64) -> Result<(), Refusal> {
        self.fence_person(key, epoch);
        match self.held.get(key) {
            None => Err(Refusal::NoClaim),
            Some(Holder::Person { .. }) => Err(Refusal::Person),
            // Input from a view of an older binding: refuse it and leave the
            // newer claim alone.
            Some(Holder::Agent(c)) if c.epoch > epoch => Err(Refusal::Stale),
            // The claim is for an older binding: it is fenced.
            Some(Holder::Agent(c)) if c.epoch < epoch => {
                let own = c.run == run;
                self.held.remove(key);
                Err(if own { Refusal::Stale } else { Refusal::NoClaim })
            }
            Some(Holder::Agent(c)) if c.run != run => Err(Refusal::HeldBy(c.run.clone())),
            Some(Holder::Agent(_)) => Ok(()),
        }
    }

    /// The person typed into `key`. An agent's claim ends and the person
    /// holds the terminal until they hand it back. With no agent claim the
    /// person's typing changes nothing here.
    pub(crate) fn person_input(&mut self, key: &Key, epoch: u64) -> bool {
        match self.held.get(key) {
            Some(Holder::Agent(c)) if c.epoch == epoch => {
                let from = c.run.clone();
                self.held.insert(key.clone(), Holder::Person { from, epoch });
                true
            }
            // A claim for an older binding was already fenced; it holds nothing to stop.
            Some(Holder::Agent(c)) if c.epoch < epoch => {
                self.held.remove(key);
                false
            }
            // Typing seen through a view of an older binding says nothing
            // about the newer claim.
            Some(Holder::Agent(_)) => false,
            _ => false,
        }
    }

    /// A takeover ends with the binding it was made on.
    fn fence_person(&mut self, key: &Key, epoch: u64) {
        if matches!(self.held.get(key), Some(Holder::Person { epoch: at, .. }) if *at < epoch) {
            self.held.remove(key);
        }
    }

    /// The person hands the terminal back. No agent holds it afterwards; an
    /// agent claims it again through `claim`.
    pub(crate) fn hand_back(&mut self, key: &Key) -> bool {
        matches!(self.held.get(key), Some(Holder::Person { .. })) && self.held.remove(key).is_some()
    }

    /// `run` gives its claim on `key` up.
    pub(crate) fn release(&mut self, key: &Key, run: &str) -> bool {
        if matches!(self.held.get(key), Some(Holder::Agent(c)) if c.run == run) {
            self.held.remove(key);
            return true;
        }
        false
    }

    /// Runs the page saw finish: their claims end, and they get no new ones.
    pub(crate) fn runs_ended(&mut self, runs: &[String]) {
        let ended: BTreeSet<&String> = runs.iter().collect();
        self.held
            .retain(|_, holder| !matches!(holder, Holder::Agent(c) if ended.contains(&c.run)));
        self.ended.extend(runs.iter().cloned());
    }

    /// The words `workbench.read` shows for `key`.
    pub(crate) fn describe(&self, key: &Key, epoch: u64) -> &'static str {
        match self.held.get(key) {
            None => "agent input: no claim",
            Some(Holder::Person { epoch: at, .. }) if *at < epoch => "agent input: no claim",
            Some(Holder::Person { .. }) => "agent input: stopped, the person took over",
            Some(Holder::Agent(c)) if c.epoch != epoch => "agent input: no claim",
            Some(Holder::Agent(_)) => "agent input: claimed",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(s: &str) -> Key {
        Key {
            workspace: "w".into(),
            session: s.into(),
        }
    }

    #[test]
    fn an_agent_types_only_with_a_claim_the_table_issued() {
        let mut c = Control::default();
        assert_eq!(c.check(&key("t"), "r1", 1), Err(Refusal::NoClaim));
        let claim = c.claim(key("t"), "r1", 1).unwrap();
        assert_eq!(c.check(&key("t"), "r1", 1), Ok(()));
        // Asking again returns the same claim, not a second one.
        assert_eq!(c.claim(key("t"), "r1", 1).unwrap(), claim);
    }

    #[test]
    fn one_agent_at_a_time_per_terminal() {
        let mut c = Control::default();
        c.claim(key("t"), "r1", 1).unwrap();
        assert_eq!(c.claim(key("t"), "r2", 1), Err(Refusal::HeldBy("r1".into())));
        assert_eq!(c.check(&key("t"), "r2", 1), Err(Refusal::HeldBy("r1".into())));
        // A different terminal is separate.
        assert!(c.claim(key("u"), "r2", 1).is_ok());
    }

    #[test]
    fn the_persons_input_stops_the_agent_until_handed_back() {
        let mut c = Control::default();
        c.claim(key("t"), "r1", 1).unwrap();
        assert!(c.person_input(&key("t"), 1));
        assert_eq!(c.check(&key("t"), "r1", 1), Err(Refusal::Person));
        assert_eq!(c.claim(key("t"), "r1", 1), Err(Refusal::Person));
        assert_eq!(c.claim(key("t"), "r2", 1), Err(Refusal::Person));
        assert!(c.hand_back(&key("t")));
        // Handing back grants nothing: the agent claims again.
        assert_eq!(c.check(&key("t"), "r1", 1), Err(Refusal::NoClaim));
        assert!(c.claim(key("t"), "r1", 1).is_ok());
    }

    #[test]
    fn the_persons_typing_with_no_agent_claim_locks_nothing() {
        let mut c = Control::default();
        assert!(!c.person_input(&key("t"), 1));
        assert!(c.claim(key("t"), "r1", 1).is_ok());
    }

    #[test]
    fn a_rebind_fences_the_old_claim() {
        let mut c = Control::default();
        let old = c.claim(key("t"), "r1", 1).unwrap();
        assert_eq!(c.check(&key("t"), "r1", 2), Err(Refusal::Stale));
        let new = c.claim(key("t"), "r1", 2).unwrap();
        assert!(new.id > old.id);
        // Another run may claim a terminal whose only claim is for an older epoch.
        let mut c = Control::default();
        c.claim(key("t"), "r1", 1).unwrap();
        assert!(c.claim(key("t"), "r2", 2).is_ok());
    }

    #[test]
    fn a_claim_ends_when_its_run_finishes_and_not_before() {
        let mut c = Control::default();
        c.claim(key("t"), "r1", 1).unwrap();
        c.claim(key("u"), "side", 1).unwrap();
        c.runs_ended(&["other".into()]);
        assert_eq!(c.check(&key("t"), "r1", 1), Ok(()));
        // A side chat's run ends the same way as a main turn's.
        c.runs_ended(&["r1".into(), "side".into()]);
        assert_eq!(c.check(&key("t"), "r1", 1), Err(Refusal::NoClaim));
        assert_eq!(c.check(&key("u"), "side", 1), Err(Refusal::NoClaim));
    }

    #[test]
    fn release_is_the_holders_only() {
        let mut c = Control::default();
        c.claim(key("t"), "r1", 1).unwrap();
        assert!(!c.release(&key("t"), "r2"));
        assert!(c.release(&key("t"), "r1"));
        assert_eq!(c.check(&key("t"), "r1", 1), Err(Refusal::NoClaim));
    }

    #[test]
    fn a_takeover_ends_with_its_binding() {
        let mut c = Control::default();
        c.claim(key("t"), "r1", 1).unwrap();
        assert!(c.person_input(&key("t"), 1));
        assert_eq!(c.claim(key("t"), "r1", 1), Err(Refusal::Person));
        assert!(c.claim(key("t"), "r1", 2).is_ok());
    }

    #[test]
    fn the_persons_typing_does_not_revive_a_fenced_claim() {
        let mut c = Control::default();
        c.claim(key("t"), "r1", 1).unwrap();
        assert!(!c.person_input(&key("t"), 2));
        assert!(c.claim(key("t"), "r2", 2).is_ok());
    }

    #[test]
    fn a_view_of_an_older_binding_cannot_displace_a_newer_claim() {
        let mut c = Control::default();
        let held = c.claim(key("t"), "r1", 2).unwrap();
        assert_eq!(c.claim(key("t"), "r2", 0), Err(Refusal::Stale));
        assert_eq!(c.claim(key("t"), "r1", 1), Err(Refusal::Stale));
        assert_eq!(c.check(&key("t"), "r1", 1), Err(Refusal::Stale));
        assert_eq!(c.check(&key("t"), "r2", 1), Err(Refusal::Stale));
        assert!(!c.person_input(&key("t"), 1));
        // The newer claim is untouched by all of it.
        assert_eq!(c.check(&key("t"), "r1", 2), Ok(()));
        assert_eq!(c.claim(key("t"), "r1", 2).unwrap(), held);
    }

    #[test]
    fn a_run_that_stopped_working_claims_nothing_more() {
        let mut c = Control::default();
        c.runs_ended(&["r1".into()]);
        assert_eq!(c.claim(key("t"), "r1", 1), Err(Refusal::Ended));
        assert!(c.claim(key("t"), "r2", 1).is_ok());
    }
}
