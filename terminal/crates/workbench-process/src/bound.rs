//! A pane bound to one terminal session: its screen, the effects it has in
//! flight, and the host events that move it between states. Every view of a
//! terminal may type, paste and resize. Every field that says what the process
//! is doing comes from a host field, never from output text (R32).

use std::collections::BTreeMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use ratatui::layout::Rect;
use theorem_workbench_core::completion::{Outcome, TerminalOpened};
use theorem_workbench_core::effect::{
    Effect, EffectBody, InputKind, TerminalAttach, TerminalBackend, TerminalClaim, TerminalInput,
    TerminalInputBytes, TerminalResize,
};
use theorem_workbench_core::host::{
    ConnectivityState, HostMessage, ProgramReport, TerminalAdoption, TerminalModes,
};
use theorem_workbench_core::ids::{EffectId, Generation, ResourceRef};
use theorem_workbench_core::{Ctx, EmitError};
use theorem_workbench_vt::Screen;

/// What the host says about the program, from its own fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Status {
    Running,
    Exited {
        code: Option<i32>,
        reason: String,
    },
    /// The host could not say more. Never shown as a continuation of
    /// anything. `link` is true when what was lost is the connection to the
    /// terminal, not the program: the program may still be running, and the
    /// host saying the connection is back clears it. A loss that is not `link`
    /// is never cleared by the host's word about the connection.
    Lost {
        reason: String,
        next_step: Option<String>,
        link: bool,
    },
}

impl Status {
    /// The program is known to be gone or its fate was reported as ended. A
    /// lost connection is not that: the program may still be running.
    pub(crate) fn program_ended(&self) -> bool {
        matches!(
            self,
            Status::Exited { .. } | Status::Lost { link: false, .. }
        )
    }
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
    /// The attach that makes the pane a view at all.
    Initial,
    /// A request for the host's authoritative repaint.
    Repaint,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Delivery {
    Pending,
    /// The outcome is unknown. Resent only by a person, with the same id.
    Unknown(String),
}

#[derive(Clone, Debug)]
pub(crate) struct Sent {
    pub body: Wire,
    pub delivery: Delivery,
}

/// One logical input as it leaves: text when the bytes are UTF-8, base64
/// otherwise. Both carry the same id and claim rules.
#[derive(Clone, Debug)]
pub(crate) enum Wire {
    Text(TerminalInput),
    Bytes(TerminalInputBytes),
}

impl Wire {
    fn effect_body(&self) -> EffectBody {
        match self {
            Self::Text(t) => EffectBody::TerminalInput(t.clone()),
            Self::Bytes(b) => EffectBody::TerminalInputBytes(b.clone()),
        }
    }
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
    Ended,
    /// The connection to the terminal is lost; nothing leaves the pane until
    /// it is back or the person attaches again.
    Disconnected,
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
    pub status: Status,
    pub provenance: Provenance,
    pub screen: Screen,
    /// False until the host has said how big its grid is.
    pub size_known: bool,
    held: Vec<Held>,
    /// The attach effects in flight.
    pub attaches: BTreeMap<EffectId, Purpose>,
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
    pub end: EndAsk,
    end_effect: Option<EffectId>,
    pub selecting: bool,
    /// The previous program of this pane, when this one was started to follow
    /// a lost one.
    pub follows: Option<String>,
    /// The host settled its listing and the session was not in it.
    pub gone: bool,
    /// What the program says about itself (R32): its own word, kept apart
    /// from everything above, which is the pane's and the host's.
    pub report: ProgramReport,
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
            end: EndAsk::No,
            end_effect: None,
            selecting: false,
            follows: None,
            gone: false,
            report: ProgramReport::Unavailable,
        }
    }

    /// Start the screen in the modes the host reports for the session. The
    /// vt screen reads modes from the stream, so they are replayed as the
    /// escape sequences that set them; the stream offset stays at zero, and a
    /// later repaint or output replaces them like any other state.
    pub(crate) fn seed_modes(&mut self, m: &TerminalModes) {
        use theorem_workbench_core::host::{MouseEncoding, MouseProtocol};
        let mut seq = String::new();
        let mut set = |on: bool, on_seq: &str| {
            if on {
                seq.push_str(on_seq);
            }
        };
        set(m.alternate_screen, "\x1b[?1049h");
        set(m.application_cursor, "\x1b[?1h");
        set(m.application_keypad, "\x1b=");
        set(m.bracketed_paste, "\x1b[?2004h");
        set(m.hide_cursor, "\x1b[?25l");
        seq.push_str(match m.mouse_protocol {
            MouseProtocol::None => "",
            MouseProtocol::Press => "\x1b[?9h",
            MouseProtocol::PressRelease => "\x1b[?1000h",
            MouseProtocol::ButtonMotion => "\x1b[?1002h",
            MouseProtocol::AnyMotion => "\x1b[?1003h",
        });
        seq.push_str(match m.mouse_encoding {
            MouseEncoding::Default => "",
            MouseEncoding::Utf8 => "\x1b[?1005h",
            MouseEncoding::Sgr => "\x1b[?1006h",
        });
        if !seq.is_empty() {
            self.screen.reset_with_formatted(seq.as_bytes(), 0);
        }
    }

    /// A listing arrived. Only a settled one proves absence: under a pending
    /// or unavailable one, or from a host that does not say, a missing
    /// session may just not be found yet.
    pub(crate) fn listed(&mut self, data: &crate::catalog::CatalogData) {
        let present = data
            .sessions
            .iter()
            .any(|s| s.session == self.session && s.workspace == self.workspace);
        match data.adoption {
            Some(TerminalAdoption::Settled) => self.gone = !present,
            _ if present => self.gone = false,
            _ => {}
        }
        // The host's own word on the program outranks a pane that has seen no
        // exit event: a listed Lost or Exited terminal is not running.
        if matches!(
            self.status,
            Status::Running | Status::Lost { link: true, .. }
        ) && let Some(row) = data
            .sessions
            .iter()
            .find(|s| s.session == self.session && s.workspace == self.workspace)
        {
            match row.state {
                theorem_workbench_core::host::TerminalSessionState::Running => {
                    if matches!(self.status, Status::Lost { .. }) && !self.gone {
                        self.status = Status::Running;
                    }
                }
                theorem_workbench_core::host::TerminalSessionState::Exited => {
                    self.status = Status::Exited {
                        code: None,
                        reason: "the host lists this terminal as exited".into(),
                    };
                }
                theorem_workbench_core::host::TerminalSessionState::Lost => {
                    self.status = Status::Lost {
                        reason: row
                            .reason
                            .clone()
                            .unwrap_or_else(|| "the host lists this terminal as lost".into()),
                        next_step: row.next_step.clone(),
                        link: true,
                    };
                }
            }
        }
    }

    /// The host's word about the connection to this terminal's core. A loss
    /// is held only while the program is not known to have ended, and a
    /// `running` clears only a loss that came from here: an exited terminal,
    /// one the host stopped listing, and a program reported lost stay as they
    /// are.
    pub(crate) fn connectivity(
        &mut self,
        state: ConnectivityState,
        reason: Option<&String>,
        next_step: Option<&String>,
    ) {
        match state {
            ConnectivityState::Lost => {
                if matches!(
                    self.status,
                    Status::Running | Status::Lost { link: true, .. }
                ) {
                    self.status = Status::Lost {
                        reason: reason.cloned().unwrap_or_default(),
                        next_step: next_step.cloned(),
                        link: true,
                    };
                }
            }
            ConnectivityState::Running => {
                if matches!(self.status, Status::Lost { link: true, .. }) && !self.gone {
                    self.status = Status::Running;
                }
            }
        }
    }

    /// The program's own report replaces the one held unless it is older by
    /// the core's sequence. Nothing else changes: no effect, no notice, no
    /// lifecycle or key state.
    pub(crate) fn hold_report(&mut self, report: ProgramReport) {
        if self.report.replaced_by(&report) {
            self.report = report;
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
            epoch: self.epoch,
        }
    }

    pub(crate) fn emit(&self, cx: &mut Ctx, body: EffectBody) -> Result<EffectId, EmitError> {
        let resource = self.resource();
        let generation = Generation(self.epoch);
        cx.emit(|id| Effect::new(id, resource, body).with_generation(generation))
    }

    pub(crate) fn running(&self) -> bool {
        self.status == Status::Running
    }

    pub(crate) fn attaching(&self) -> bool {
        self.initial.is_some()
    }

    /// Whether keys, paste and resize may leave this pane.
    pub(crate) fn gate(&self) -> Result<(), Block> {
        if matches!(self.status, Status::Lost { link: true, .. }) {
            return Err(Block::Disconnected);
        }
        if !self.running() {
            return Err(Block::Ended);
        }
        if self.end == EndAsk::Pending {
            return Err(Block::Ending);
        }
        if self.attaching() {
            return Err(Block::Attaching);
        }
        Ok(())
    }

    // ---- attach ---------------------------------------------------------

    pub(crate) fn attach(&mut self, cx: &mut Ctx, purpose: Purpose, from_offset: u64) -> bool {
        let body = EffectBody::TerminalAttach(TerminalAttach {
            from_offset,
            attachment: self.attachment.clone(),
        });
        match self.emit(cx, body) {
            Ok(effect) => {
                self.attaches.insert(effect, purpose);
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
            .any(|purpose| *purpose == Purpose::Repaint)
        {
            return;
        }
        let from = self.screen.applied_offset();
        self.attach(cx, Purpose::Repaint, from);
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
        if kind == InputKind::Human {
            self.reclaim_size();
        }
        let input_id = self.mint();
        let claim = self.claim();
        let body = match std::str::from_utf8(bytes) {
            Ok(text) => Wire::Text(TerminalInput {
                bytes: text.to_owned(),
                kind,
                input_id,
                claim,
            }),
            // Legacy mouse reports and the like are raw bytes: they travel as
            // base64 under the same ledger rather than being dropped.
            Err(_) => Wire::Bytes(TerminalInputBytes {
                data: B64.encode(bytes),
                kind,
                input_id,
                claim,
            }),
        };
        match self.emit(cx, body.effect_body()) {
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
            match self.emit(cx, sent.body.effect_body()) {
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

    /// This view is in use again: its size follows, as tmux's latest view.
    pub(crate) fn reclaim_size(&mut self) {
        self.requested = None;
    }

    /// One resize in flight; the latest wanted size follows it.
    pub(crate) fn pump_resize(&mut self, cx: &mut Ctx) {
        if !self.size_known
            || self.resize.is_some()
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
                    // The key was aimed at a binding the host has since
                    // replaced: re-attach to learn the current one. The input
                    // is not sent again.
                    if code == "terminal_control_refused" && reason == "stale_epoch" {
                        self.notice = Some(Note::new(
                            Tone::Error,
                            "Input refused: the terminal was rebound after this view last attached (host: stale_epoch). It was not sent again; attaching to the current binding.",
                        ));
                        self.ask_repaint(cx);
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
        let purpose = self.attaches.remove(&effect)?;
        match outcome {
            Outcome::Accepted => {
                if let Some(opened) = opened {
                    self.apply_opened(cx, opened, purpose);
                }
                None
            }
            Outcome::Uncertain { reason } => {
                if purpose == Purpose::Initial {
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
                self.attach_failed(purpose, Some(code), reason, true)
            }
            Outcome::Failed { reason } => self.attach_failed(purpose, None, reason, false),
        }
    }

    fn attach_failed(
        &mut self,
        purpose: Purpose,
        code: Option<String>,
        reason: String,
        refused: bool,
    ) -> Option<AttachFailure> {
        if purpose == Purpose::Initial {
            return Some(AttachFailure {
                code,
                reason,
                refused,
            });
        }
        self.notice = Some(Note::new(
            Tone::Error,
            format!("The host refused: {reason}."),
        ));
        if purpose == Purpose::Repaint {
            self.awaiting_repaint = false;
        }
        None
    }

    /// The answer to an open that attached in the same effect.
    pub(crate) fn opened(&mut self, cx: &mut Ctx, opened: &TerminalOpened) {
        self.apply_opened(cx, opened, Purpose::Initial);
    }

    fn apply_opened(&mut self, cx: &mut Ctx, opened: &TerminalOpened, purpose: Purpose) {
        if opened.epoch > self.epoch && self.epoch != 0 {
            self.report = ProgramReport::Unavailable;
            self.screen = Screen::new(opened.rows.max(1), opened.cols.max(1));
            self.awaiting_repaint = true;
        }
        if opened.epoch >= self.epoch {
            self.epoch = opened.epoch;
            self.program = opened.program;
        }
        // The host mints its own attachment name when it does not know the one
        // asked for; every later claim, input, resize and detach must carry
        // the name it returned, or it answers `unknown_attachment`.
        if let Some(attachment) = &opened.attachment {
            self.attachment = attachment.clone();
        }
        self.origin = opened.origin.clone();
        self.stream_epoch = opened.stream_epoch.clone();
        self.owner = opened.process_owner().to_owned();
        if opened.cols > 0 && opened.rows > 0 && self.screen.size() != (opened.rows, opened.cols) {
            self.screen.resize(opened.rows, opened.cols);
        }
        if purpose == Purpose::Initial {
            self.initial = None;
            self.status = Status::Running;
            self.provenance = match &opened.origin {
                Some(origin) => Provenance::from_origin(origin),
                None => Provenance::None,
            };
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
                if !replies.is_empty() && self.running() {
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
        // What a reset means is read from the epoch and from whether this
        // pane asked for it, never from the screen: a newer epoch is the same
        // program under a new binding; an unasked repaint of the same epoch
        // after output was applied is the host's own log reset. The first
        // repaint after an attach is part of the attach and changes nothing.
        if epoch > self.epoch {
            self.epoch = epoch;
            self.report = ProgramReport::Unavailable;
            self.provenance = Provenance::Continued;
        } else if !self.awaiting_repaint && self.screen.applied_offset() > 0 {
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
                    // Another view's size stands: this view asks again only
                    // when its own size changes or it is used again.
                    self.size_known = true;
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
                if new_epoch {
                    self.report = ProgramReport::Unavailable;
                }
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
                        next_step: None,
                        link: false,
                    }
                } else {
                    Status::Exited {
                        code: *exit_code,
                        reason: reason.clone(),
                    }
                };
            }
            HostMessage::TerminalConnectivity {
                epoch,
                state,
                reason,
                next_step,
                ..
            } => {
                if *epoch < self.epoch {
                    return;
                }
                self.connectivity(*state, reason.as_ref(), next_step.as_ref());
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
