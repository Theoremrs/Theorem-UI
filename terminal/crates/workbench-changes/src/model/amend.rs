//! Amending the last commit: turning the box on, and filling it with the message the log
//! already holds.
//!
//! Written for this crate; not translated. The donor's box only sets a flag and the
//! donor's commit asks git to amend. Here the last commit's message is not known until the
//! log is read, so turning amend on reads it first when it is not loaded, and the message
//! is filled in when the log arrives. The log's entries carry the subject only, so a
//! commit's description is not carried into an amend.

use super::{ActionKind, Changes, Intent, LogState, Refusal};

impl Changes {
    /// The subject of the newest commit, when the log has been read.
    pub fn last_commit_subject(&self) -> Option<&str> {
        match &self.log {
            LogState::Ready(entries) => entries.first().map(|e| e.subject.as_str()),
            _ => None,
        }
    }

    /// Whether amend is on and waits for the log to say what the last message was.
    pub fn amend_waiting(&self) -> bool {
        self.amend_wanted
    }

    /// Turns amend on. A host without `scm.commit.amend` refuses, and so does a
    /// repository with no commit. The message of the last commit fills an empty draft:
    /// from the log if it is loaded, else once the log answers, which this asks for.
    pub fn begin_amend(&mut self) -> Result<Option<Intent>, Refusal> {
        if self.snapshot.is_none() {
            return self.refuse(ActionKind::Commit, Refusal::NotLoaded);
        }
        if !self.amend_available {
            return self.refuse(ActionKind::Commit, Refusal::AmendUnavailable);
        }
        match &self.log {
            LogState::NoCommits => self.refuse(ActionKind::Commit, Refusal::NoCommits),
            LogState::Ready(_) => {
                self.amend = true;
                self.fill_from_last_commit();
                Ok(None)
            }
            LogState::Loading => {
                self.amend = true;
                self.amend_wanted = true;
                Ok(None)
            }
            _ => {
                self.amend = true;
                self.amend_wanted = true;
                match self.request_log() {
                    Some(intent) => Ok(Some(intent)),
                    None => {
                        // The repository has no HEAD, so no commit to amend.
                        self.amend = false;
                        self.amend_wanted = false;
                        self.refuse(ActionKind::Commit, Refusal::NoCommits)
                    }
                }
            }
        }
    }

    /// Turns amend off. A message that amend loaded and nobody edited goes with it.
    pub fn end_amend(&mut self) {
        self.amend = false;
        self.amend_wanted = false;
        if let Some(loaded) = self.amend_loaded.take()
            && self.subject == loaded
            && self.body.is_empty()
        {
            self.subject.clear();
        }
    }

    fn fill_from_last_commit(&mut self) {
        if self.subject.trim().is_empty()
            && self.body.is_empty()
            && let Some(subject) = self.last_commit_subject().map(str::to_owned)
        {
            self.subject = subject.clone();
            self.amend_loaded = Some(subject);
        }
    }

    /// Called when a log answer has been applied: finishes an amend that waited for it.
    pub(super) fn log_read_for_amend(&mut self) {
        if !self.amend_wanted {
            return;
        }
        self.amend_wanted = false;
        match &self.log {
            LogState::Ready(_) if self.amend => self.fill_from_last_commit(),
            LogState::Ready(_) => {}
            _ => self.amend = false,
        }
    }
}
