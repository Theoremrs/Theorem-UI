//! A pane bound to one terminal session: its screen, its lease, the effects it
//! has in flight, and the host events that move it between states. Every field
//! that says what the process is doing comes from a host field, never from
//! output text (R32).

use std::collections::BTreeMap;

use ratatui::layout::Rect;
use theorem_workbench_core::completion::{Outcome, TerminalOpened};
use theorem_workbench_core::effect::{
    Effect, EffectBody, InputKind, TerminalAttach, TerminalBackend, TerminalClaim, TerminalInput,
    TerminalResize, TerminalRole,
};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{EffectId, Generation, ResourceRef};
use theorem_workbench_core::{Ctx, EmitError};
use theorem_workbench_vt::Screen;

/// What a pane wants of the lease when it attaches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Want {
    Controller,
    Observer,
}

impl Want {
    pub(crate) fn role(self) -> TerminalRole {
        match self {
            Self::Controller => TerminalRole::Controller,
            Self::Observer => TerminalRole::Observer,
        }
    }
}

/// Why a view is not the controller.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Why {
    /// Attached to observe, by choice.
    Chosen,
    /// Re-attached after a restore without taking control from anyone.
    Restored,
    /// The host's word in `terminal_control_refused`.
    Lease(String),
    /// A `terminal.control` event said another viewer holds the lease.
    Lost(u64),
}

impl Why {
    pub(crate) fn text(&self) -> String {
        match self {
            Self::Chosen => "This view attached to observe and did not take control.".into(),
            Self::Restored => {
                "This pane re-attached without taking control from anyone.".into()
            }
            Self::Lease(word) => match word.as_str() {
                "observer" => "This view is attached as an observer (host: observer).".into(),
                "held" => "Another viewer holds control (host: held).".into(),
                "stale_generation" => {
                    "Control moved to another viewer since this view last held it (host: stale_generation)."
                        .into()
                }
                "stale_epoch" => {
                    "The terminal was rebound since this view last held control (host: stale_epoch)."
                        .into()
                }
                "unknown_attachment" => {
                    "The host does not know this view's attachment (host: unknown_attachment)."
                        .into()
                }
                other => format!("The host refused control (host: {other})."),
            },
            Self::Lost(generation) => {
                format!("Another viewer took control (lease generation {generation}).")
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Role {
    Controller,
    Observer(Why),
}

/// What the host says about the program, from its own fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Status {
    Running,
    Exited {
        code: Option<i32>,
        reason: String,
    },
    /// The program is gone and the host could not say more. Never shown as a
    /// continuation of anything.
    Lost {
        reason: String,
    },
}

/// How this binding came to be, kept in the host's words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Provenance {
    None,
    Launched,
    Adopted,
    /// The browser attached again to a program that kept running.
    Reattached,
    /// A different process took the terminal's place.
    Replacement,
    /// Same program, new binding epoch.
    Continued,
    /// The host repainted at an offset of the same epoch.
    HostReset(u64),
    Other(String),
}

impl Provenance {
    pub(crate) fn from_origin(origin: &str) -> Self {
        match origin {
            "launched" => Self::Launched,
            "adopted" => Self::Adopted,
            "reattached" => Self::Reattached,
            "replacement" => Self::Replacement,
            other => Self::Other(other.to_owned()),
        }
    }

    pub(crate) fn text(&self, program: u64, epoch: u64) -> Option<String> {
        Some(match self {
            Self::None => return None,
            Self::Launched => format!("Started in this pane as program {program}."),
            Self::Adopted => {
                format!("Adopted a terminal that was started elsewhere (program {program}).")
            }
            Self::Reattached => format!(
                "Re-attached to program {program}, which kept running while no view was attached."
            ),
            Self::Replacement => format!(
                "Program replaced: the original is gone and program {program} took its place. The original work did not resume."
            ),
            Self::Continued => {
                format!("The same program ({program}) continues under binding epoch {epoch}.")
            }
            Self::HostReset(offset) => {
                format!("The host repainted this screen at byte {offset} (host log reset).")
            }
            Self::Other(word) => format!("The host reports the origin as \"{word}\"."),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tone {
    Error,
    Warning,
    Muted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Note {
    pub tone: Tone,
    pub text: String,
}

impl Note {
    pub(crate) fn new(tone: Tone, text: impl Into<String>) -> Self {
        Self {
            tone,
            text: text.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Purpose {
    /// The attach that makes the pane a viewer at all.
    Initial,
    /// A request to take the lease.
    Control,
    /// A request for the host's authoritative repaint.
    Repaint,
}

#[derive(Clone, Debug)]
pub(crate) struct Attaching {
    pub purpose: Purpose,
    pub want: Want,
    pub why: Why,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Delivery {
    Pending,
    /// The outcome is unknown. Resent only by a person, with the same id.
    Unknown(String),
}

#[derive(Clone, Debug)]
pub(crate) struct Sent {
    pub body: TerminalInput,
    pub delivery: Delivery,
}

/// Frames that arrived before the host said how big the grid is.
#[derive(Clone, Debug)]
pub(crate) enum Held {
    Output {
        epoch: u64,
        offset: u64,
        bytes: Vec<u8>,
    },
    Reset {
        epoch: u64,
        offset: u64,
        formatted: Vec<u8>,
    },
}

const HELD_LIMIT: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum EndAsk {
    No,
    Asking,
    Pending,
    /// The host did not say whether the process ended. Not resent.
    Unknown(String),
}

/// Why a key or paste could not be sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Block {
    Observing(String),
    Ended,
    Attaching,
    /// An End was asked of the host; keys would go to a program being ended.
    Ending,
    Full,
}

pub(crate) struct Bound {
    pub workspace: String,
    prefix: String,
    seq: u64,
    pub session: String,
    pub backend: TerminalBackend,
    pub attachment: String,
    /// The profile it was opened from in this pane, if it was: lets a lost
    /// program be followed by an explicit new one of the same kind.
    pub profile: Option<crate::state::Choice>,
    pub epoch: u64,
    pub program: u64,
    pub origin: Option<String>,
    pub stream_epoch: Option<String>,
    pub owner: String,
    pub lease: u64,
    pub role: Role,
    pub status: Status,
    pub provenance: Provenance,
    pub screen: Screen,
    /// False until the host has said how big its grid is.
    pub size_known: bool,
    held: Vec<Held>,
    /// The attach effects in flight.
    pub attaches: BTreeMap<EffectId, Attaching>,
    /// Set while the first attach has not been answered, or answered
    /// `Uncertain`.
    pub initial: Option<Option<String>>,
    pub inputs: BTreeMap<EffectId, Sent>,
    /// What the body asks of the program's grid, as (cols, rows).
    pub want: (u16, u16),
    requested: Option<(u16, u16)>,
    resize: Option<EffectId>,
    pub awaiting_repaint: bool,
    pub notice: Option<Note>,
    pub offer_control: bool,
    pub end: EndAsk,
    end_effect: Option<EffectId>,
    pub selecting: bool,
    /// The previous program of this pane, when this one was started to follow
    /// a lost one.
    pub follows: Option<String>,
}

impl Bound {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        workspace: String,
        prefix: String,
        session: String,
        backend: TerminalBackend,
        attachment: String,
        cols: u16,
        rows: u16,
    ) -> Self {
        Self {
            workspace,
            prefix,
            seq: 0,
            session,
            backend,
            attachment,
            profile: None,
            epoch: 0,
            program: 0,
            origin: None,
            stream_epoch: None,
            owner: match backend {
                TerminalBackend::Herdr => "herdr-core".into(),
                TerminalBackend::Native => "host".into(),
            },
            lease: 0,
            role: Role::Observer(Why::Chosen),
            status: Status::Running,
            provenance: Provenance::None,
            screen: Screen::new(rows.max(1), cols.max(1)),
            size_known: false,
            held: vec![],
            attaches: BTreeMap::new(),
            initial: Some(None),
            inputs: BTreeMap::new(),
            want: (cols, rows),
            requested: None,
            resize: None,
            awaiting_repaint: false,
            notice: None,
            offer_control: false,
            end: EndAsk::No,
            end_effect: None,
            selecting: false,
            follows: None,
        }
    }

    pub(crate) fn resource(&self) -> ResourceRef {
        ResourceRef::Terminal {
            workspace: self.workspace.clone(),
            session: self.session.clone(),
        }
    }

    pub(crate) fn claim(&self) -> TerminalClaim {
        TerminalClaim {
            attachment: self.attachment.clone(),
            lease_generation: self.lease,
            epoch: self.epoch,
        }
    }

    pub(crate) fn emit(&self, cx: &mut Ctx, body: EffectBody) -> Result<EffectId, EmitError> {
        let resource = self.resource();
        let generation = Generation(self.epoch);
        cx.emit(|id| Effect::new(id, resource, body).with_generation(generation))
    }

    pub(crate) fn controlling(&self) -> bool {
        matches!(self.role, Role::Controller)
    }

    pub(crate) fn running(&self) -> bool {
        self.status == Status::Running
    }

    pub(crate) fn attaching(&self) -> bool {
        self.initial.is_some()
    }

    /// Whether keys, paste and resize may leave this pane.
    pub(crate) fn gate(&self) -> Result<(), Block> {
        if !self.running() {
            return Err(Block::Ended);
        }
        if self.end == EndAsk::Pending {
            return Err(Block::Ending);
        }
        if self.attaching() {
            return Err(Block::Attaching);
        }
        match &self.role {
            Role::Controller => Ok(()),
            Role::Observer(why) => Err(Block::Observing(why.text())),
        }
    }

    // ---- attach ---------------------------------------------------------

    pub(crate) fn attach(
        &mut self,
        cx: &mut Ctx,
        purpose: Purpose,
        want: Want,
        why: Why,
        from_offset: u64,
    ) -> bool {
        let body = EffectBody::TerminalAttach(TerminalAttach {
            from_offset,
            role: want.role(),
            attachment: self.attachment.clone(),
        });
        match self.emit(cx, body) {
            Ok(effect) => {
                self.attaches
                    .insert(effect, Attaching { purpose, want, why });
                true
            }
            Err(error) => {
                self.notice = Some(Note::new(
                    Tone::Error,
                    format!("Could not ask the host: {error}"),
                ));
                false
            }
        }
    }

    /// Ask for the host's authoritative repaint, once at a time.
    pub(crate) fn ask_repaint(&mut self, cx: &mut Ctx) {
        self.awaiting_repaint = true;
        if self
            .attaches
            .values()
            .any(|a| a.purpose == Purpose::Repaint)
        {
            return;
        }
        // The same role it has: a holder that attached as an observer would
        // give the lease up.
        let (want, why) = match &self.role {
            Role::Controller => (Want::Controller, Why::Chosen),
            Role::Observer(why) => (Want::Observer, why.clone()),
        };
        let from = self.screen.applied_offset();
        self.attach(cx, Purpose::Repaint, want, why, from);
    }

    pub(crate) fn request_control(&mut self, cx: &mut Ctx) {
        self.offer_control = false;
        if self.controlling() || !self.running() {
            return;
        }
        let from = self.screen.applied_offset();
        if self.attach(cx, Purpose::Control, Want::Controller, Why::Chosen, from) {
            self.notice = Some(Note::new(Tone::Muted, "Asking the host for control."));
        }
    }

    // ---- input ----------------------------------------------------------

    fn mint(&mut self) -> String {
        self.seq += 1;
        format!("{}.{}", self.prefix, self.seq)
    }

    /// Send bytes as one logical input with a fresh id. Returns why not when
    /// the pane may not.
    pub(crate) fn send(
        &mut self,
        cx: &mut Ctx,
        bytes: &[u8],
        kind: InputKind,
    ) -> Result<(), Block> {
        self.gate()?;
        let Ok(text) = String::from_utf8(bytes.to_vec()) else {
            // The wire carries text; bytes that are not UTF-8 (a legacy mouse
            // report) cannot be sent faithfully, so nothing is sent.
            return Ok(());
        };
        let body = TerminalInput {
            bytes: text,
            kind,
            input_id: self.mint(),
            claim: self.claim(),
        };
        match self.emit(cx, EffectBody::TerminalInput(body.clone())) {
            Ok(effect) => {
                self.inputs.insert(
                    effect,
                    Sent {
                        body,
                        delivery: Delivery::Pending,
                    },
                );
                self.screen.scroll_to_bottom();
                Ok(())
            }
            Err(_) => Err(Block::Full),
        }
    }

    /// Send every input whose outcome is unknown again, with the id and the
    /// claim it first carried, so the host writes it once.
    pub(crate) fn resend(&mut self, cx: &mut Ctx) {
        let unknown: Vec<EffectId> = self
            .inputs
            .iter()
            .filter(|(_, s)| matches!(s.delivery, Delivery::Unknown(_)))
            .map(|(id, _)| *id)
            .collect();
        for old in unknown {
            let Some(sent) = self.inputs.remove(&old) else {
                continue;
            };
            match self.emit(cx, EffectBody::TerminalInput(sent.body.clone())) {
                Ok(effect) => {
                    self.inputs.insert(
                        effect,
                        Sent {
                            body: sent.body,
                            delivery: Delivery::Pending,
                        },
                    );
                }
                Err(_) => {
                    self.inputs.insert(old, sent);
                }
            }
        }
    }

    pub(crate) fn unknown_inputs(&self) -> usize {
        self.inputs
            .values()
            .filter(|s| matches!(s.delivery, Delivery::Unknown(_)))
            .count()
    }

    // ---- resize ---------------------------------------------------------

    /// One resize in flight; the latest wanted size follows it.
    pub(crate) fn pump_resize(&mut self, cx: &mut Ctx) {
        if !self.size_known
            || self.resize.is_some()
            || !self.controlling()
            || !self.running()
            || self.attaching()
        {
            return;
        }
        let (rows, cols) = self.screen.size();
        let want = self.want;
        if want.0 == 0 || want.1 == 0 || want == (cols, rows) || self.requested == Some(want) {
            return;
        }
        let body = EffectBody::TerminalResize(TerminalResize {
            cols: want.0,
            rows: want.1,
            claim: self.claim(),
        });
        if let Ok(effect) = self.emit(cx, body) {
            self.resize = Some(effect);
            self.requested = Some(want);
        }
    }

    // ---- end ------------------------------------------------------------

    pub(crate) fn end_process(&mut self, cx: &mut Ctx) {
        self.end = EndAsk::Pending;
        match self.emit(cx, EffectBody::TerminalEnd) {
            Ok(effect) => self.end_effect = Some(effect),
            Err(error) => {
                self.end = EndAsk::No;
                self.notice = Some(Note::new(
                    Tone::Error,
                    format!("Could not ask the host to end the process: {error}"),
                ));
            }
        }
    }

    // ---- completions ----------------------------------------------------

    /// Fold the answer to one of this pane's effects in. Returns what the
    /// pane must do beyond its own state.
    pub(crate) fn complete(
        &mut self,
        cx: &mut Ctx,
        effect: EffectId,
        outcome: Outcome,
        opened: Option<&TerminalOpened>,
    ) -> Option<AttachFailure> {
        if let Some(mut sent) = self.inputs.remove(&effect) {
            match outcome {
                Outcome::Accepted => {}
                Outcome::Refused { code, reason } => {
                    if code == "terminal_control_refused" {
                        self.role = Role::Observer(Why::Lease(reason.clone()));
                        self.notice = Some(Note::new(
                            Tone::Error,
                            format!("Input refused. {}", Why::Lease(reason).text()),
                        ));
                    } else {
                        self.notice = Some(Note::new(
                            Tone::Error,
                            format!("Input refused: {reason} ({code})."),
                        ));
                    }
                }
                Outcome::Uncertain { reason } => {
                    sent.delivery = Delivery::Unknown(reason.clone());
                    self.inputs.insert(effect, sent);
                    self.notice = Some(Note::new(
                        Tone::Warning,
                        format!(
                            "Input unconfirmed ({reason}). It was not resent; click here to resend the same input."
                        ),
                    ));
                }
                Outcome::Failed { reason } => {
                    self.notice = Some(Note::new(Tone::Error, format!("Input failed: {reason}.")));
                }
            }
            return None;
        }
        if self.resize == Some(effect) {
            self.resize = None;
            match outcome {
                Outcome::Accepted => {}
                Outcome::Refused { reason, .. } | Outcome::Failed { reason } => {
                    self.notice = Some(Note::new(
                        Tone::Warning,
                        format!("Resize refused: {reason}."),
                    ));
                }
                Outcome::Uncertain { reason } => {
                    self.notice = Some(Note::new(
                        Tone::Warning,
                        format!("Resize outcome unknown: {reason}."),
                    ));
                }
            }
            return None;
        }
        if self.end_effect == Some(effect) {
            self.end_effect = None;
            match outcome {
                Outcome::Accepted => {
                    self.notice = Some(Note::new(
                        Tone::Muted,
                        "End requested. Waiting for the host to report the exit.",
                    ));
                }
                Outcome::Refused { reason, .. } | Outcome::Failed { reason } => {
                    self.end = EndAsk::No;
                    self.notice = Some(Note::new(
                        Tone::Error,
                        format!("The process was not ended: {reason}."),
                    ));
                }
                Outcome::Uncertain { reason } => {
                    self.end = EndAsk::Unknown(reason);
                }
            }
            return None;
        }
        let attaching = self.attaches.remove(&effect)?;
        match outcome {
            Outcome::Accepted => {
                if let Some(opened) = opened {
                    self.apply_opened(cx, opened, &attaching);
                }
                None
            }
            Outcome::Uncertain { reason } => {
                if attaching.purpose == Purpose::Initial {
                    self.initial = Some(Some(reason));
                } else {
                    self.notice = Some(Note::new(
                        Tone::Warning,
                        format!("Whether the host accepted the request is unknown: {reason}."),
                    ));
                }
                None
            }
            Outcome::Refused { code, reason } => {
                self.attach_failed(attaching, Some(code), reason, true)
            }
            Outcome::Failed { reason } => self.attach_failed(attaching, None, reason, false),
        }
    }

    fn attach_failed(
        &mut self,
        attaching: Attaching,
        code: Option<String>,
        reason: String,
        refused: bool,
    ) -> Option<AttachFailure> {
        if attaching.purpose == Purpose::Initial {
            return Some(AttachFailure {
                code,
                reason,
                refused,
            });
        }
        if code.as_deref() == Some("terminal_control_refused") {
            self.role = Role::Observer(Why::Lease(reason.clone()));
            self.notice = Some(Note::new(
                Tone::Error,
                format!("Control refused. {}", Why::Lease(reason).text()),
            ));
        } else {
            self.notice = Some(Note::new(
                Tone::Error,
                format!("The host refused: {reason}."),
            ));
        }
        if attaching.purpose == Purpose::Repaint {
            self.awaiting_repaint = false;
        }
        None
    }

    fn apply_opened(&mut self, cx: &mut Ctx, opened: &TerminalOpened, attaching: &Attaching) {
        if opened.epoch > self.epoch && self.epoch != 0 {
            self.screen = Screen::new(opened.rows.max(1), opened.cols.max(1));
            self.awaiting_repaint = true;
        }
        if opened.epoch >= self.epoch {
            self.epoch = opened.epoch;
            self.program = opened.program;
        }
        self.origin = opened.origin.clone();
        self.stream_epoch = opened.stream_epoch.clone();
        self.owner = opened.process_owner().to_owned();
        if let Some(generation) = opened.lease_generation {
            self.lease = generation;
        }
        if opened.cols > 0 && opened.rows > 0 && self.screen.size() != (opened.rows, opened.cols) {
            self.screen.resize(opened.rows, opened.cols);
        }
        match attaching.purpose {
            Purpose::Initial => {
                self.initial = None;
                self.status = Status::Running;
                self.provenance = match &opened.origin {
                    Some(origin) => Provenance::from_origin(origin),
                    None => Provenance::None,
                };
                self.role = match attaching.want {
                    Want::Controller => Role::Controller,
                    Want::Observer => Role::Observer(attaching.why.clone()),
                };
            }
            Purpose::Control => {
                self.role = Role::Controller;
                self.notice = None;
            }
            Purpose::Repaint => {}
        }
        self.size_known = true;
        self.flush_held(cx);
    }

    // ---- stream ---------------------------------------------------------

    fn flush_held(&mut self, cx: &mut Ctx) {
        for held in std::mem::take(&mut self.held) {
            match held {
                Held::Output {
                    epoch,
                    offset,
                    bytes,
                } => self.output(cx, epoch, offset, &bytes),
                Held::Reset {
                    epoch,
                    offset,
                    formatted,
                } => self.reset(epoch, offset, &formatted),
            }
        }
    }

    pub(crate) fn output(&mut self, cx: &mut Ctx, epoch: u64, offset: u64, bytes: &[u8]) {
        if !self.size_known {
            if self.held.len() < HELD_LIMIT {
                self.held.push(Held::Output {
                    epoch,
                    offset,
                    bytes: bytes.to_vec(),
                });
            } else {
                self.awaiting_repaint = true;
            }
            return;
        }
        if epoch < self.epoch {
            return;
        }
        if epoch > self.epoch {
            // The binding changed and nothing announced it: this frame's
            // offsets belong to a log this screen has not seen. Ask for the
            // repaint instead of guessing.
            self.ask_repaint(cx);
            return;
        }
        if self.awaiting_repaint && self.screen.applied_offset() == 0 && offset != 0 {
            self.ask_repaint(cx);
            return;
        }
        match self.screen.feed_at(offset, bytes) {
            Ok(_) => {
                let replies = self.screen.take_replies();
                if !replies.is_empty() && self.controlling() && self.running() {
                    let _ = self.send(cx, &replies, InputKind::Reply);
                }
                let _ = self.screen.take_bells();
            }
            Err(gap) => {
                self.notice = Some(Note::new(
                    Tone::Warning,
                    format!("Output skipped bytes ({gap}). Asking the host for a repaint."),
                ));
                self.ask_repaint(cx);
            }
        }
    }

    pub(crate) fn reset(&mut self, epoch: u64, offset: u64, formatted: &[u8]) {
        if !self.size_known {
            if self.held.len() < HELD_LIMIT {
                self.held.push(Held::Reset {
                    epoch,
                    offset,
                    formatted: formatted.to_vec(),
                });
            }
            return;
        }
        if epoch < self.epoch {
            return;
        }
        let newer = epoch > self.epoch;
        if newer {
            self.epoch = epoch;
            // The screen was cleared for the new binding by whoever announced
            // it; a reset that arrives alone replaces it the same way.
            if matches!(self.provenance, Provenance::None | Provenance::Launched)
                || !self.awaiting_repaint
            {
                self.provenance = Provenance::Continued;
            }
        } else if !self.awaiting_repaint {
            self.provenance = Provenance::HostReset(offset);
        }
        self.screen.reset_with_formatted(formatted, offset);
        self.awaiting_repaint = false;
    }

    // ---- host events ----------------------------------------------------

    pub(crate) fn host(&mut self, cx: &mut Ctx, message: &HostMessage) {
        match message {
            HostMessage::TerminalResized { cols, rows, .. } => {
                if *cols > 0 && *rows > 0 {
                    if self.screen.size() != (*rows, *cols) {
                        self.screen.resize(*rows, *cols);
                    }
                    self.size_known = true;
                    if self.requested != Some((*cols, *rows)) {
                        self.requested = None;
                    }
                    self.flush_held(cx);
                }
            }
            HostMessage::TerminalOpened {
                epoch,
                program,
                origin,
                cols,
                rows,
                ..
            } => {
                if *epoch < self.epoch {
                    return;
                }
                let new_epoch = *epoch > self.epoch;
                let new_program = *program != self.program;
                if !new_epoch && !new_program {
                    return;
                }
                let replaced = origin == "replacement" || *program > self.program;
                self.epoch = *epoch;
                self.program = *program;
                self.origin = Some(origin.clone());
                let (rows, cols) = if *cols > 0 && *rows > 0 {
                    (*rows, *cols)
                } else {
                    self.screen.size()
                };
                self.screen = Screen::new(rows, cols);
                self.size_known = true;
                self.status = Status::Running;
                self.requested = None;
                self.provenance = if replaced {
                    Provenance::Replacement
                } else {
                    Provenance::Continued
                };
                self.ask_repaint(cx);
            }
            HostMessage::TerminalExited {
                epoch,
                exit_code,
                reason,
                ..
            } => {
                if *epoch < self.epoch {
                    return;
                }
                self.end = EndAsk::No;
                self.status = if reason == "lost" {
                    Status::Lost {
                        reason: reason.clone(),
                    }
                } else {
                    Status::Exited {
                        code: *exit_code,
                        reason: reason.clone(),
                    }
                };
            }
            HostMessage::TerminalControl {
                epoch,
                generation,
                controlled,
                ..
            } => {
                if *epoch < self.epoch {
                    return;
                }
                if *controlled {
                    self.role = Role::Controller;
                    self.lease = *generation;
                    self.offer_control = false;
                } else {
                    if *generation >= self.lease {
                        self.lease = *generation;
                    }
                    if self.controlling() {
                        self.role = Role::Observer(Why::Lost(*generation));
                        self.notice = Some(Note::new(
                            Tone::Warning,
                            "Control moved to another viewer. Output keeps arriving here.",
                        ));
                    }
                }
            }
            _ => {}
        }
    }

    pub(crate) fn set_want(&mut self, term: Rect) {
        self.want = (term.width, term.height);
    }
}

/// An initial attach the host answered with a refusal or a failure.
pub(crate) struct AttachFailure {
    pub code: Option<String>,
    pub reason: String,
    pub refused: bool,
}
