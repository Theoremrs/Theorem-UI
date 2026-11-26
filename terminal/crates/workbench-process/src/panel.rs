//! The process pane. `update` is the only place state changes; `view` and
//! `semantics` read it. See the crate docs for the states.

use std::collections::BTreeSet;
use std::rc::Rc;

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use serde_json::{Value, json};
use terminput::{MouseButton, MouseEvent, MouseEventKind, ScrollDirection};
use theorem_workbench_core::completion::{Completion, CompletionPayload, Outcome};
use theorem_workbench_core::effect::{
    ClipboardWrite, Effect, EffectBody, InputKind, TerminalAbandonOpen, TerminalBackend,
    TerminalClaim, TerminalOpen,
};
use theorem_workbench_core::host::{ConnectionState, HostMessage};
use theorem_workbench_core::ids::{
    ActionId, Actor, EffectId, Generation, ResourceRef, WorkspaceIdentity,
};
use theorem_workbench_core::semantics::Node;
use theorem_workbench_core::stale::Binding;
use theorem_workbench_core::{Button, Ctx, Panel, PanelMsg, PanelPointer, PointerKind, ViewCtx};
use theorem_workbench_vt::{
    MouseProtocolMode, Pos, SelectionKind, encode_key, encode_mouse, encode_paste,
};

use theorem_workbench_core::panels::{
    ACTION_CODE_SEND, ACTION_CODE_START, ACTION_CODE_STOP, CODING_PROFILES,
};

use crate::bound::{AttachFailure, Block, Bound, EndAsk, Note, Purpose, Tone};
use crate::catalog::{Catalog, CatalogData};
use crate::chooser::{self, Row, RowKind};
use crate::draw::{self, Geo};
use crate::keys::{key_event, mouse_modifiers};
use crate::semantics;
use crate::state::{Choice, Failure, FailureKind, Intent, Opening, Saved, Stage};
use crate::styles::ProcessStyles;

const SAVED_VERSION: u64 = 1;
const DEFAULT_SIZE: (u16, u16) = (80, 24);

/// Work owed for a binding the pane left while it could not emit.
enum Deferred {
    Detach {
        resource: ResourceRef,
        claim: TerminalClaim,
    },
    /// An open still in flight when the pane left: its session is undone.
    Abandon {
        resource: ResourceRef,
        open: EffectId,
    },
}

pub struct ProcessPanel {
    pub(crate) catalog: Catalog,
    pub(crate) styles: Rc<ProcessStyles>,
    pub(crate) identity: WorkspaceIdentity,
    pub(crate) body: Rect,
    pub(crate) stage: Stage,
    pub(crate) selected: usize,
    pub(crate) note: Option<String>,
    pub(crate) connection: Option<ConnectionState>,
    seen: u64,
    binds: u64,
    /// Launch intents minted, for their ids.
    launches: u64,
    /// A launch that failed or whose outcome is unknown: the profile it was
    /// of and its operation id. Choosing the same profile again is a second
    /// attempt of it and carries the same id; anything else is a new launch.
    unsettled: Option<(String, String)>,
    deferred: Vec<Deferred>,
    /// Opens the pane stopped waiting for: their answer is never shown as the
    /// current state, but a process that started is said so.
    abandoned: BTreeSet<EffectId>,
    pending_focus: Option<bool>,
    /// The agent run whose `code.start` opened this pane's terminal: it is
    /// issued an input claim once the terminal is bound (IN-02: a terminal
    /// started for someone grants them control as part of its creation).
    grant: Option<String>,
}

fn plain_char(key: &KeyInput) -> Option<char> {
    match key.key() {
        Key::Char(c) if key.mods().difference(Mods::SHIFT).is_empty() => Some(c),
        _ => None,
    }
}

impl ProcessPanel {
    pub(crate) fn restore(state: &Value, catalog: Catalog, styles: Rc<ProcessStyles>) -> Self {
        let stage = match (state["session"].as_str(), state["workspace"].as_str()) {
            (Some(session), Some(workspace)) => Stage::Restoring(Saved {
                workspace: workspace.to_owned(),
                session: session.to_owned(),
                backend: match state["backend"].as_str() {
                    Some("herdr") => TerminalBackend::Herdr,
                    _ => TerminalBackend::Native,
                },
            }),
            _ => Stage::Choosing,
        };
        Self {
            seen: catalog.version(),
            catalog,
            styles,
            identity: WorkspaceIdentity::default(),
            body: Rect::default(),
            stage,
            selected: 0,
            note: None,
            connection: None,
            binds: 0,
            launches: 0,
            unsettled: None,
            deferred: vec![],
            abandoned: BTreeSet::new(),
            pending_focus: None,
            grant: None,
        }
    }

    fn rows(&self) -> Vec<Row> {
        chooser::rows(
            &self.catalog.snapshot(&self.identity.workspace),
            &self.identity,
        )
    }

    fn geo(&self) -> Geo {
        draw::geo(Rect::new(0, 0, self.body.width, self.body.height))
    }

    fn size(&self) -> (u16, u16) {
        let term = self.geo().term;
        if term.width == 0 || term.height == 0 {
            DEFAULT_SIZE
        } else {
            (term.width, term.height)
        }
    }

    fn bound(&self) -> Option<&Bound> {
        match &self.stage {
            Stage::Bound(b) => Some(b),
            _ => None,
        }
    }

    fn bound_mut(&mut self) -> Option<&mut Bound> {
        match &mut self.stage {
            Stage::Bound(b) => Some(b),
            _ => None,
        }
    }

    pub(crate) fn resource(&self) -> ResourceRef {
        match &self.stage {
            Stage::Bound(b) => b.resource(),
            Stage::Restoring(saved) => ResourceRef::Terminal {
                workspace: saved.workspace.clone(),
                session: saved.session.clone(),
            },
            Stage::Failed(Failure {
                intent: Intent::Attach { session, .. },
                ..
            }) => ResourceRef::Terminal {
                workspace: self.identity.workspace.clone(),
                session: session.clone(),
            },
            _ => ResourceRef::Workspace {
                workspace: self.identity.workspace.clone(),
            },
        }
    }

    // ---- identity -------------------------------------------------------

    fn adopt(&mut self, now: &WorkspaceIdentity) {
        if now.workspace == self.identity.workspace && now.environment == self.identity.environment
        {
            self.identity.generation = now.generation;
            return;
        }
        let was_set = self.identity.is_set();
        let previous = std::mem::replace(&mut self.identity, now.clone());
        if !was_set {
            // The first name: a restored pane for a different workspace leaves
            // on its first call that may start work.
            return;
        }
        self.leave_for_workspace(&previous);
    }

    /// The host named another workspace: detach from what this pane was
    /// attached to (the program keeps running) and show the chooser.
    fn leave_for_workspace(&mut self, previous: &WorkspaceIdentity) {
        let named = format!("The workspace changed to {}.", self.identity.workspace);
        match std::mem::replace(&mut self.stage, Stage::Choosing) {
            Stage::Bound(b) => {
                self.deferred.push(Deferred::Detach {
                    resource: b.resource(),
                    claim: b.claim(),
                });
                self.note = Some(format!(
                    "{named} This pane detached from {}; that program was not ended.",
                    b.session
                ));
            }
            Stage::Opening(op) => {
                self.abandoned.insert(op.effect);
                self.deferred.push(Deferred::Abandon {
                    resource: ResourceRef::Workspace {
                        workspace: previous.workspace.clone(),
                    },
                    open: op.effect,
                });
                self.note = Some(format!(
                    "{named} The shell that was starting for the previous workspace was abandoned: the host is asked to end it."
                ));
            }
            Stage::Restoring(saved) => {
                self.note = Some(format!(
                    "{named} This pane was saved for workspace {}.",
                    saved.workspace
                ));
            }
            _ => {}
        }
        self.selected = 0;
    }

    // ---- starting -------------------------------------------------------

    fn prefix(&self, cx: &Ctx) -> String {
        format!(
            "{}.{}.{}",
            self.catalog.nonce(),
            cx.panel().as_str(),
            self.binds
        )
    }

    fn open(&mut self, cx: &mut Ctx, choice: Choice, follows: Option<String>) {
        let (cols, rows) = self.size();
        // Open and attach are one effect: the pane names its attachment now
        // and the answer carries it back.
        self.binds += 1;
        let prefix = self.prefix(cx);
        let attachment = format!("{prefix}.a");
        let operation = match self.unsettled.take() {
            Some((profile, operation)) if profile == choice.id => operation,
            _ => {
                self.launches += 1;
                format!(
                    "{}.{}.op{}",
                    self.catalog.nonce(),
                    cx.panel().as_str(),
                    self.launches
                )
            }
        };
        let body = EffectBody::TerminalOpen(TerminalOpen {
            backend: choice.backend,
            argv: choice.argv.clone(),
            name: terminal_name(&choice.id, &prefix),
            cols,
            rows,
            attachment: Some(attachment.clone()),
            operation: Some(operation.clone()),
        });
        let resource = ResourceRef::Workspace {
            workspace: self.identity.workspace.clone(),
        };
        let generation = self.identity.generation;
        match cx.emit(|id| Effect::new(id, resource, body).with_generation(generation)) {
            Ok(effect) => {
                self.note = None;
                self.stage = Stage::Opening(Opening {
                    choice,
                    effect,
                    uncertain: None,
                    follows,
                    prefix,
                    attachment,
                    operation,
                });
            }
            Err(error) => {
                self.note = Some(format!("Not started: {error}."));
                self.stage = Stage::Choosing;
            }
        }
    }

    fn attach_to(&mut self, cx: &mut Ctx, session: String, backend: TerminalBackend) {
        self.binds += 1;
        let prefix = self.prefix(cx);
        let (cols, rows) = self.size();
        let mut bound = Bound::new(
            self.identity.workspace.clone(),
            prefix.clone(),
            session.clone(),
            backend,
            format!("{prefix}.a"),
            cols,
            rows,
        );
        // What the host says the program already asked of the terminal, so the
        // first key or mouse event is encoded before any output arrives.
        let modes = self
            .catalog
            .snapshot(&self.identity.workspace)
            .sessions
            .iter()
            .find(|s| s.session == session && s.workspace == self.identity.workspace)
            .and_then(|s| s.modes);
        if let Some(modes) = modes {
            bound.seed_modes(&modes);
        }
        if bound.attach(cx, Purpose::Initial, 0) {
            self.note = None;
            self.stage = Stage::Bound(Box::new(bound));
        } else {
            self.note = bound.notice.take().map(|n| n.text);
            self.stage = Stage::Choosing;
        }
    }

    /// `shell.attach` means the selected session row.
    fn choose_session(&mut self, cx: &mut Ctx) {
        if !matches!(self.stage, Stage::Choosing) {
            return;
        }
        if matches!(
            self.rows().get(self.selected).map(|r| &r.kind),
            Some(RowKind::Session(_))
        ) {
            self.choose(cx);
        } else {
            self.note = Some("Select an existing session first.".into());
        }
    }

    fn choose(&mut self, cx: &mut Ctx) {
        let rows = self.rows();
        let Some(row) = rows.get(self.selected) else {
            return;
        };
        if !row.enabled {
            self.note = row.reason.clone();
            return;
        }
        match &row.kind {
            RowKind::Session(s) => self.attach_to(cx, s.session.clone(), s.backend),
            RowKind::Profile(p) => {
                self.open(
                    cx,
                    Choice {
                        id: p.id.clone(),
                        label: p.label.clone(),
                        backend: p.backend,
                        argv: p.argv.clone(),
                    },
                    None,
                );
            }
        }
    }

    // ---- leaving --------------------------------------------------------

    /// Detach from the session and show the chooser. Never ends the process.
    fn back_to_chooser(&mut self, cx: &mut Ctx, note: Option<String>) {
        if let Stage::Bound(b) = &self.stage {
            let claim = b.claim();
            let _ = b.emit(cx, EffectBody::TerminalDetach(claim));
        }
        if let Stage::Opening(op) = &self.stage {
            self.abandoned.insert(op.effect);
            let open = op.effect;
            let resource = ResourceRef::Workspace {
                workspace: self.identity.workspace.clone(),
            };
            let generation = self.identity.generation;
            let _ = cx.emit(|id| {
                Effect::new(
                    id,
                    resource,
                    EffectBody::TerminalAbandonOpen(TerminalAbandonOpen { open }),
                )
                .with_generation(generation)
            });
        }
        self.stage = Stage::Choosing;
        self.note = note;
    }

    // ---- keys -----------------------------------------------------------

    fn on_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        match &self.stage {
            Stage::Choosing => self.chooser_key(key, cx),
            Stage::Restoring(_) => {
                if key.key() == Key::Esc {
                    self.stage = Stage::Choosing;
                }
            }
            Stage::Opening(_) => {
                if key.key() == Key::Esc {
                    self.back_to_chooser(cx, Some("Stopped waiting. The host is asked to end the shell this open creates.".into()));
                }
            }
            Stage::Failed(_) => self.failed_key(key, cx),
            Stage::Bound(_) => self.bound_key(key, cx),
        }
    }

    fn chooser_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        let count = self.rows().len();
        let last = count.saturating_sub(1);
        match (key.key(), plain_char(&key)) {
            (Key::Up, _) | (_, Some('k')) => self.selected = self.selected.saturating_sub(1),
            (Key::Down, _) | (_, Some('j')) => self.selected = (self.selected + 1).min(last),
            (Key::Home, _) => self.selected = 0,
            (Key::End, _) => self.selected = last,
            (Key::Enter, _) => self.choose(cx),
            _ => return,
        }
        if self.selected > last {
            self.selected = last;
        }
        self.note = None;
    }

    fn failed_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        match key.key() {
            Key::Enter => self.retry_failed(cx),
            Key::Esc => {
                self.stage = Stage::Choosing;
                self.note = None;
            }
            _ => {}
        }
    }

    /// An explicit second attempt of an open or an attach the host refused.
    fn retry_failed(&mut self, cx: &mut Ctx) {
        let Stage::Failed(failure) = std::mem::replace(&mut self.stage, Stage::Choosing) else {
            return;
        };
        match failure.intent {
            Intent::Open(choice) => self.open(cx, choice, None),
            Intent::Attach { session, backend } => self.attach_to(cx, session, backend),
        }
    }

    fn bound_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        let catalog = self.catalog.clone();
        let Some(b) = self.bound_mut() else { return };
        // A question waiting for a yes takes the keyboard.
        if b.end == EndAsk::Asking {
            match key.key() {
                Key::Enter => b.end_process(cx),
                Key::Esc => b.end = EndAsk::No,
                _ => match plain_char(&key) {
                    Some('y') => b.end_process(cx),
                    Some('n') => b.end = EndAsk::No,
                    _ => {}
                },
            }
            return;
        }
        // Copy never reaches the program.
        let copy = key.mods().contains(Mods::CMD)
            || (key.mods().contains(Mods::CTRL | Mods::SHIFT) && key.key() == Key::Char('c'));
        if copy && matches!(key.key(), Key::Char('c' | 'C')) {
            self.copy_selection(cx);
            return;
        }
        let modes = b.screen.input_modes();
        // Scrollback is the pane's while the program has not taken the screen.
        let scrolls = !b.screen.alternate_screen() && modes.mouse_mode == MouseProtocolMode::None;
        if scrolls && key.mods().difference(Mods::SHIFT).is_empty() {
            match key.key() {
                Key::PageUp => {
                    b.screen.scroll_page_up();
                    return;
                }
                Key::PageDown => {
                    b.screen.scroll_page_down();
                    return;
                }
                _ => {}
            }
        }
        // The ended states take the keyboard for their own actions.
        if !b.running() {
            match key.key() {
                Key::Enter => self.attach_again(cx),
                Key::Esc => self.back_to_chooser(cx, None),
                _ => match plain_char(&key) {
                    Some('n') if !self.connection_lost() => self.start_new(cx),
                    Some('a') => self.attach_again(cx),
                    _ => {}
                },
            }
            return;
        }
        if b.attaching() {
            if key.key() == Key::Esc {
                self.back_to_chooser(cx, None);
            }
            return;
        }
        let Some(event) = key_event(&key) else { return };
        let Some(bytes) = encode_key(&event, &modes) else {
            return;
        };
        match b.send(cx, &bytes, InputKind::Human) {
            Ok(()) => took_over(&catalog, b),
            Err(block) => b.notice = Some(block_note(&block)),
        }
    }

    fn copy_selection(&mut self, cx: &mut Ctx) {
        let Some(b) = self.bound_mut() else { return };
        let Some(text) = b.screen.selection_text().filter(|t| !t.is_empty()) else {
            return;
        };
        let _ = cx.emit(|id| {
            Effect::new(
                id,
                ResourceRef::None,
                EffectBody::ClipboardWrite(ClipboardWrite { text }),
            )
        });
    }

    /// Attach to the same terminal again, by a person's choice.
    fn attach_again(&mut self, cx: &mut Ctx) {
        let (session, backend) = match &self.stage {
            Stage::Bound(b) => (b.session.clone(), b.backend),
            _ => return,
        };
        self.back_to_chooser(cx, None);
        self.attach_to(cx, session, backend);
    }

    /// Only the connection to the terminal is lost; the program may still be
    /// running, so a new shell is not the way back.
    fn connection_lost(&self) -> bool {
        matches!(
            &self.stage,
            Stage::Bound(b) if matches!(b.status, crate::bound::Status::Lost { link: true, .. })
        )
    }

    /// An explicit new process of the profile the lost one was opened from.
    /// Never presented as the same work.
    fn start_new(&mut self, cx: &mut Ctx) {
        let (choice, old) = match &self.stage {
            Stage::Bound(b) => (b.profile.clone(), b.session.clone()),
            _ => return,
        };
        self.back_to_chooser(cx, None);
        match choice {
            Some(choice) => self.open(cx, choice, Some(old)),
            None => {
                self.note = Some(format!(
                    "{old} is not running. Choose a profile to start a new shell; it is a different process."
                ));
            }
        }
    }

    // ---- text and paste -------------------------------------------------

    fn on_text(&mut self, text: String, cx: &mut Ctx) {
        let catalog = self.catalog.clone();
        let Some(b) = self.bound_mut() else { return };
        if b.end == EndAsk::Asking {
            return;
        }
        if b.gate().is_err() {
            return;
        }
        match b.send(cx, text.as_bytes(), InputKind::Human) {
            Ok(()) => took_over(&catalog, b),
            Err(block) => b.notice = Some(block_note(&block)),
        }
    }

    fn on_paste(&mut self, text: String, cx: &mut Ctx) {
        let catalog = self.catalog.clone();
        let Some(b) = self.bound_mut() else { return };
        if b.end == EndAsk::Asking {
            return;
        }
        if b.gate().is_err() {
            return;
        }
        let bytes = encode_paste(&text, &b.screen.input_modes());
        match b.send(cx, &bytes, InputKind::Human) {
            Ok(()) => took_over(&catalog, b),
            Err(block) => b.notice = Some(block_note(&block)),
        }
    }

    // ---- pointer --------------------------------------------------------

    fn on_pointer(&mut self, p: PanelPointer, cx: &mut Ctx) {
        match &self.stage {
            Stage::Choosing => self.chooser_pointer(p, cx),
            Stage::Bound(_) => self.bound_pointer(p, cx),
            _ => {}
        }
    }

    fn chooser_pointer(&mut self, p: PanelPointer, cx: &mut Ctx) {
        let rows = self.rows();
        match p.kind {
            PointerKind::Wheel { dy, .. } => {
                let last = rows.len().saturating_sub(1);
                self.selected = if dy > 0 {
                    (self.selected + 1).min(last)
                } else {
                    self.selected.saturating_sub(1)
                };
            }
            PointerKind::Down(Button::Left) => {
                let data = self.catalog.snapshot(&self.identity.workspace);
                let lines = chooser::lines(
                    &rows,
                    &self.identity,
                    data.adoption.as_ref(),
                    self.note.as_deref(),
                    self.body.width,
                );
                let height = usize::from(self.body.height);
                let top = chooser::top_for(
                    &lines,
                    self.selected.min(rows.len().saturating_sub(1)),
                    height,
                );
                let Ok(y) = usize::try_from(p.y) else { return };
                if let Some(row) = lines.get(top + y).and_then(|l| l.row) {
                    self.selected = row;
                    self.note = None;
                    if p.clicks >= 2 {
                        self.choose(cx);
                    }
                }
            }
            _ => {}
        }
    }

    fn bound_pointer(&mut self, p: PanelPointer, cx: &mut Ctx) {
        let geo = self.geo();
        let area = Rect::new(0, 0, self.body.width, self.body.height);
        let Some(b) = self.bound_mut() else { return };
        let (x, y) = (p.x, p.y);
        // The header's End process control and the footer's resend control.
        if matches!(p.kind, PointerKind::Down(Button::Left)) {
            let hit = draw::end_button(geo.header, b).is_some_and(|r| {
                y == i32::from(r.y) && x >= i32::from(r.x) && x < i32::from(r.right())
            });
            if hit {
                if b.end == EndAsk::No {
                    b.end = EndAsk::Asking;
                }
                return;
            }
            let footer = draw::footer_view(area, b);
            if footer.is_some_and(|f| y >= i32::from(f.rect.y) && y < i32::from(f.rect.bottom()))
                && b.unknown_inputs() > 0
            {
                b.resend(cx);
                return;
            }
        }
        let inside = x >= 0
            && y >= i32::from(geo.term.y)
            && x < i32::from(geo.term.width)
            && y < i32::from(geo.term.y) + i32::from(geo.term.height);
        let col = x.clamp(0, i32::from(geo.term.width.saturating_sub(1))) as u16;
        let row = (y - i32::from(geo.term.y)).clamp(0, i32::from(geo.term.height.saturating_sub(1)))
            as u16;
        let modes = b.screen.input_modes();
        let wants_mouse = modes.mouse_mode != MouseProtocolMode::None;
        let can_send = b.gate().is_ok();

        // Wheel: scrollback unless the program took the mouse.
        if let PointerKind::Wheel { dy, .. } = p.kind {
            if wants_mouse && can_send && inside {
                let direction = if dy < 0 {
                    ScrollDirection::Up
                } else {
                    ScrollDirection::Down
                };
                let event = MouseEvent {
                    kind: MouseEventKind::Scroll(direction),
                    column: col,
                    row,
                    modifiers: mouse_modifiers(p.mods),
                };
                if let Some(bytes) = encode_mouse(&event, &modes) {
                    let _ = b.send(cx, &bytes, InputKind::Human);
                }
            } else if !b.screen.alternate_screen() {
                if dy > 0 {
                    b.screen.scroll_down(dy as usize);
                } else {
                    b.screen.scroll_up(dy.unsigned_abs() as usize);
                }
            }
            return;
        }

        // The program asked for the mouse and this view may answer it.
        if wants_mouse && can_send {
            let kind = match p.kind {
                PointerKind::Down(button) => Some(MouseEventKind::Down(map_button(button))),
                PointerKind::Up(button) => Some(MouseEventKind::Up(map_button(button))),
                PointerKind::Move if b.selecting => None,
                PointerKind::Move => Some(MouseEventKind::Moved),
                PointerKind::Wheel { .. } => None,
            };
            if let (Some(kind), true) = (kind, inside) {
                let event = MouseEvent {
                    kind,
                    column: col,
                    row,
                    modifiers: mouse_modifiers(p.mods),
                };
                if let Some(bytes) = encode_mouse(&event, &modes) {
                    let _ = b.send(cx, &bytes, InputKind::Human);
                }
            }
            return;
        }

        // Otherwise the pointer selects, locally.
        match p.kind {
            PointerKind::Down(Button::Left) if inside => {
                let at: Pos = b.screen.view_pos(row, col);
                let kind = match p.clicks {
                    0 | 1 => SelectionKind::Cell,
                    2 => SelectionKind::Word,
                    _ => SelectionKind::Line,
                };
                b.screen.select(kind, at);
                b.selecting = true;
            }
            PointerKind::Move if b.selecting => {
                let at = b.screen.view_pos(row, col);
                b.screen.extend_selection(at);
            }
            PointerKind::Up(Button::Left) => {
                if b.selecting {
                    let at = b.screen.view_pos(row, col);
                    b.screen.extend_selection(at);
                }
                b.selecting = false;
            }
            _ => {}
        }
    }

    // ---- completions ----------------------------------------------------

    fn on_completion(&mut self, c: Completion, cx: &mut Ctx) {
        if self.abandoned.remove(&c.effect) {
            if matches!(c.outcome, Outcome::Accepted)
                && let Some(CompletionPayload::Terminal(t)) = &c.payload
            {
                self.note = Some(format!(
                    "{} was started after you left the wait. It is listed under existing sessions.",
                    t.session
                ));
            }
            return;
        }
        if let Stage::Opening(op) = &self.stage
            && op.effect == c.effect
        {
            let Stage::Opening(op) = std::mem::replace(&mut self.stage, Stage::Choosing) else {
                return;
            };
            self.opened(cx, op, c);
            return;
        }
        let Stage::Bound(b) = &mut self.stage else {
            return;
        };
        let opened = match &c.payload {
            Some(CompletionPayload::Terminal(t)) => Some(t),
            _ => None,
        };
        if let Some(failure) = b.complete(cx, c.effect, c.outcome, opened) {
            let (session, backend) = (b.session.clone(), b.backend);
            self.stage = Stage::Failed(failure_of(failure, session, backend));
        }
    }

    /// The answer to an open. Only an accepted one starts anything.
    fn opened(&mut self, cx: &mut Ctx, op: Opening, c: Completion) {
        // Until a session is named, this launch is unsettled: choosing the
        // same profile again is a second attempt of it, never a new launch.
        self.unsettled = Some((op.choice.id.clone(), op.operation.clone()));
        match c.outcome {
            Outcome::Accepted => {
                let Some(CompletionPayload::Terminal(t)) = c.payload else {
                    self.grant = None;
                    self.stage = Stage::Failed(Failure {
                        kind: FailureKind::Failed,
                        reason: "The host accepted the open but named no session.".into(),
                        code: None,
                        intent: Intent::Open(op.choice),
                    });
                    return;
                };
                let attachment = t.attachment.clone().unwrap_or(op.attachment);
                let mut b = Bound::new(
                    self.identity.workspace.clone(),
                    op.prefix,
                    t.session.clone(),
                    t.backend,
                    attachment,
                    t.cols,
                    t.rows,
                );
                self.unsettled = None;
                b.profile = Some(op.choice);
                b.follows = op.follows;
                b.opened(cx, &t);
                if let Some(run) = self.grant.take() {
                    let _ = self.catalog.control().claim(control_key(&b), &run, b.epoch);
                }
                self.stage = Stage::Bound(Box::new(b));
            }
            Outcome::Uncertain { reason } => {
                self.stage = Stage::Opening(Opening {
                    uncertain: Some(reason),
                    ..op
                });
            }
            Outcome::Refused { code, reason } => {
                // An open that did not happen grants no one: a retry is the person's.
                self.grant = None;
                let kind = if code == "terminal_backend_unavailable" {
                    FailureKind::Unavailable
                } else {
                    FailureKind::Refused
                };
                self.stage = Stage::Failed(Failure {
                    kind,
                    reason,
                    code: Some(code),
                    intent: Intent::Open(op.choice),
                });
            }
            Outcome::Failed { reason } => {
                self.grant = None;
                self.stage = Stage::Failed(Failure {
                    kind: FailureKind::Failed,
                    reason,
                    code: None,
                    intent: Intent::Open(op.choice),
                });
            }
        }
    }

    // ---- host -----------------------------------------------------------

    fn on_host(&mut self, message: HostMessage, cx: &mut Ctx) {
        if let HostMessage::FollowedRuns { runs } = &message {
            self.catalog.control().working_runs(runs);
            cx.invalidate();
            return;
        }
        if let HostMessage::ConnectionChanged { workspace, state } = &message
            && *workspace == self.identity.workspace
        {
            self.connection = Some(*state);
            return;
        }
        if let HostMessage::TerminalSessions {
            workspace,
            profiles,
            sessions,
            adoption,
        } = message
        {
            // A listing said for another workspace is not this pane's.
            if workspace == self.identity.workspace {
                let data = CatalogData {
                    workspace,
                    profiles,
                    sessions,
                    adoption,
                };
                if let Some(b) = self.bound_mut() {
                    b.listed(&data);
                }
                self.catalog.replace(data);
                cx.invalidate();
            }
            return;
        }
        if let Some(b) = self.bound_mut() {
            b.host(cx, &message);
        }
    }

    // ---- actions --------------------------------------------------------

    fn on_action(&mut self, id: ActionId, cx: &mut Ctx) {
        match id.as_str() {
            "shell.start" => match &self.stage {
                Stage::Choosing => self.choose(cx),
                Stage::Failed(_) => self.retry_failed(cx),
                Stage::Bound(_) if self.connection_lost() => self.attach_again(cx),
                Stage::Bound(b) if !b.running() => self.start_new(cx),
                _ => {}
            },
            "shell.reconnect" if self.connection_lost() => self.attach_again(cx),
            "shell.attach" => self.choose_session(cx),
            "shell.resend" => {
                if let Some(b) = self.bound_mut() {
                    b.resend(cx);
                }
            }
            "shell.end" => {
                if let Some(b) = self.bound_mut()
                    && b.running()
                    && !b.attaching()
                {
                    // Asking is all this does; confirming is a person's own
                    // action (`shell.end.confirm`, human only) or key.
                    b.end = EndAsk::Asking;
                }
            }
            "shell.end.confirm" => {
                if let Some(b) = self.bound_mut()
                    && b.end == EndAsk::Asking
                {
                    b.end_process(cx);
                }
            }
            ACTION_CODE_START => self.start_coding(cx),
            ACTION_CODE_SEND => self.type_coding(cx, true),
            ACTION_CODE_STOP => self.type_coding(cx, false),
            crate::ACTION_CODE_CLAIM => self.claim_input(cx),
            crate::ACTION_CODE_RELEASE => self.release_input(cx),
            crate::ACTION_SHELL_HAND_BACK => self.hand_back(cx),
            _ => {}
        }
    }

    /// `code.start`: open the coding CLI's profile with the task as its last
    /// argument. Only a profile the host lists and offers here; never a
    /// native shell in its place.
    fn start_coding(&mut self, cx: &mut Ctx) {
        let Some(task) = cx.args().input().map(str::to_owned) else {
            cx.refuse("code.start needs the task as input.");
            return;
        };
        let Some(profile) = CODING_PROFILES
            .iter()
            .find(|(name, _)| Some(*name) == cx.args().option())
            .map(|(_, profile)| *profile)
        else {
            cx.refuse("A shell runs the claude or codex coding agent only.");
            return;
        };
        if !matches!(self.stage, Stage::Choosing) {
            cx.refuse("This shell is already bound to a terminal.");
            return;
        }
        let rows = self.rows();
        let Some((p, row)) = rows.iter().find_map(|row| match &row.kind {
            RowKind::Profile(p) if p.id == profile => Some((p, row)),
            _ => None,
        }) else {
            cx.refuse(format!(
                "The host does not offer the {profile} profile here."
            ));
            return;
        };
        if !row.enabled {
            cx.refuse(
                row.reason
                    .clone()
                    .unwrap_or_else(|| format!("{profile} is unavailable here.")),
            );
            return;
        }
        let Some(mut argv) = p.argv.clone() else {
            cx.refuse(format!("{profile} names no program to give the task to."));
            return;
        };
        argv.push(task);
        self.grant = match cx.actor() {
            Actor::Agent { run_id } => Some(run_id.clone()),
            Actor::Human => None,
        };
        let choice = Choice {
            id: p.id.clone(),
            label: p.label.clone(),
            backend: p.backend,
            argv: Some(argv),
        };
        self.open(cx, choice, None);
        if !matches!(self.stage, Stage::Opening(_)) {
            let why = self.note.clone().unwrap_or_else(|| "Not started.".into());
            cx.refuse(why);
        }
    }

    /// The coding profile this pane's bound terminal runs, if it is one: the
    /// profile it was opened from here, else the one the host names for the
    /// session. `code.send` and `code.stop` act on coding sessions only.
    fn coding_profile(&self) -> Option<String> {
        let Stage::Bound(b) = &self.stage else {
            return None;
        };
        let listed = self
            .catalog
            .snapshot(&b.workspace)
            .sessions
            .into_iter()
            .find(|session| session.session == b.session && session.workspace == b.workspace);
        let current = listed
            .as_ref()
            .and_then(|session| session.command.as_deref())
            .map(|command| {
                let program = command.trim().rsplit('/').next().unwrap_or("");
                CODING_PROFILES
                    .iter()
                    .find(|(option, _)| *option == program)
                    .map(|(_, profile)| (*profile).to_owned())
            });
        let named = current
            .unwrap_or_else(|| listed.map(|session| session.profile))
            .or_else(|| b.profile.as_ref().map(|choice| choice.id.clone()));
        named.filter(|id| CODING_PROFILES.iter().any(|(_, label)| id == label))
    }

    /// `code.claim`: an agent run asks for the input claim on this pane's
    /// terminal. Issued unless the person took over or another run holds it.
    fn claim_input(&mut self, cx: &mut Ctx) {
        let Actor::Agent { run_id } = cx.actor().clone() else {
            cx.refuse("code.claim is an agent's request; the person types without one.");
            return;
        };
        let Some(b) = self.bound() else {
            cx.refuse("This shell is not attached to a terminal.");
            return;
        };
        let (key, epoch) = (control_key(b), b.epoch);
        if let Err(refusal) = self.catalog.control().claim(key, &run_id, epoch) {
            cx.refuse(refusal.text());
        }
        cx.invalidate();
    }

    /// `code.release`: the agent run gives its claim up. Ending a claim
    /// never ends the process.
    fn release_input(&mut self, cx: &mut Ctx) {
        let Actor::Agent { run_id } = cx.actor().clone() else {
            cx.refuse("code.release gives up an agent's claim; the person holds none.");
            return;
        };
        let Some(b) = self.bound() else {
            cx.refuse("This shell is not attached to a terminal.");
            return;
        };
        if !self.catalog.control().release(&control_key(b), &run_id) {
            cx.refuse("This run holds no input claim on this terminal.");
        }
        cx.invalidate();
    }

    /// `shell.hand_back` (human only): the person ends their takeover. No
    /// agent holds the terminal afterwards until one claims it again.
    fn hand_back(&mut self, cx: &mut Ctx) {
        let Some(b) = self.bound() else {
            cx.refuse("This shell is not attached to a terminal.");
            return;
        };
        if !self.catalog.control().hand_back(&control_key(b)) {
            cx.refuse("No agent was stopped from typing into this terminal.");
        }
        cx.invalidate();
    }

    /// `code.send` pastes the words and presses Enter; `code.stop` sends
    /// Ctrl-C, which asks the program to stop and never ends the process.
    fn type_coding(&mut self, cx: &mut Ctx, send: bool) {
        let coding = self.coding_profile();
        let catalog = self.catalog.clone();
        let text = cx.args().input().map(str::to_owned);
        let Some(b) = self.bound_mut() else {
            cx.refuse("This shell is not attached to a terminal.");
            return;
        };
        if coding.is_none() {
            let action = if send { "code.send" } else { "code.stop" };
            cx.refuse(format!(
                "{action} steers a claude or codex coding session, not this shell."
            ));
            return;
        }
        if b.end == EndAsk::Asking {
            cx.refuse("The person is being asked whether to end this process.");
            return;
        }
        if let Actor::Agent { run_id } = cx.actor().clone()
            && let Err(refusal) = catalog.control().check(&control_key(b), &run_id, b.epoch)
        {
            cx.refuse(refusal.text());
            return;
        }
        let bytes: Vec<Vec<u8>> = if send {
            let Some(text) = text else {
                cx.refuse("code.send needs the words to send as input.");
                return;
            };
            vec![encode_paste(&text, &b.screen.input_modes()), b"\r".to_vec()]
        } else {
            vec![b"\x03".to_vec()]
        };
        for chunk in bytes {
            if let Err(block) = b.send(cx, &chunk, InputKind::Human) {
                let note = block_note(&block);
                cx.refuse(note.text.clone());
                b.notice = Some(note);
                return;
            }
        }
    }

    fn on_tick(&mut self, cx: &mut Ctx) {
        self.flush_deferred(cx);
        if let Stage::Restoring(saved) = &self.stage
            && self.identity.is_set()
        {
            let saved = saved.clone();
            if saved.workspace != self.identity.workspace {
                self.stage = Stage::Choosing;
                self.note = Some(format!(
                    "This pane was saved for workspace {}; the host now names {}.",
                    saved.workspace, self.identity.workspace
                ));
            } else {
                self.attach_to(cx, saved.session, saved.backend);
            }
        }
        if let Some(focused) = self.pending_focus.take()
            && let Some(b) = self.bound_mut()
            && b.gate().is_ok()
            && let Some(bytes) =
                theorem_workbench_vt::encode_focus(focused, &b.screen.input_modes())
        {
            let _ = b.send(cx, &bytes, InputKind::Human);
        }
        if self.catalog.version() != self.seen {
            self.seen = self.catalog.version();
            let count = self.rows().len();
            self.selected = self.selected.min(count.saturating_sub(1));
            cx.invalidate();
        }
    }

    fn flush_deferred(&mut self, cx: &mut Ctx) {
        for d in std::mem::take(&mut self.deferred) {
            let _ = match d {
                Deferred::Detach { resource, claim } => {
                    let generation = Generation(claim.epoch);
                    cx.emit(|id| {
                        Effect::new(id, resource, EffectBody::TerminalDetach(claim))
                            .with_generation(generation)
                    })
                }
                Deferred::Abandon { resource, open } => cx.emit(|id| {
                    Effect::new(
                        id,
                        resource,
                        EffectBody::TerminalAbandonOpen(TerminalAbandonOpen { open }),
                    )
                }),
            };
        }
    }

    fn pump(&mut self, cx: &mut Ctx) {
        let term = self.geo().term;
        if let Some(b) = self.bound_mut() {
            b.set_want(term);
            b.pump_resize(cx);
        }
    }
}

fn map_button(button: Button) -> MouseButton {
    match button {
        Button::Left => MouseButton::Left,
        Button::Middle => MouseButton::Middle,
        Button::Right => MouseButton::Right,
    }
}

fn block_note(block: &Block) -> Note {
    match block {
        Block::Ended => Note::new(
            Tone::Warning,
            "The program is not running; nothing was sent.",
        ),
        Block::Disconnected => Note::new(
            Tone::Warning,
            "The connection to the terminal is lost; nothing was sent. Retry to reconnect.",
        ),
        Block::Attaching => Note::new(Tone::Muted, "Still attaching; nothing was sent."),
        Block::Ending => Note::new(Tone::Muted, "Ending the process; nothing was sent."),
        Block::Full => Note::new(
            Tone::Error,
            "Too many unanswered inputs; this one was not sent.",
        ),
    }
}

fn failure_of(
    failure: AttachFailure,
    session: String,
    backend: TerminalBackend,
) -> Failure {
    let kind = match failure.code.as_deref() {
        Some("terminal_session_not_found") => FailureKind::NotFound,
        Some("terminal_backend_unavailable") => FailureKind::Unavailable,
        _ if failure.refused => FailureKind::Refused,
        _ => FailureKind::Failed,
    };
    Failure {
        kind,
        reason: failure.reason,
        code: failure.code,
        intent: Intent::Attach { session, backend },
    }
}

impl Panel for ProcessPanel {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        self.adopt(cx.workspace());
        let quiet = matches!(
            msg,
            PanelMsg::Resize { .. }
                | PanelMsg::TerminalReport(_)
                | PanelMsg::Focus(_)
                | PanelMsg::Cached(_)
                | PanelMsg::Workspace(_)
        );
        match msg {
            PanelMsg::Key(key) => self.on_key(key, cx),
            PanelMsg::Text(text) => self.on_text(text, cx),
            PanelMsg::Paste(text) => self.on_paste(text, cx),
            PanelMsg::Pointer(p) => self.on_pointer(p, cx),
            PanelMsg::Resize { area, .. } => {
                self.body = area;
                let term = self.geo().term;
                if let Some(b) = self.bound_mut() {
                    b.set_want(term);
                }
            }
            PanelMsg::Focus(focused) => {
                if focused && let Some(b) = self.bound_mut() {
                    b.reclaim_size();
                }
                self.pending_focus = Some(focused);
            }
            PanelMsg::Completion(c) => self.on_completion(c, cx),
            PanelMsg::Cached(_) => {}
            PanelMsg::Host(message) => self.on_host(message, cx),
            PanelMsg::TerminalOutput {
                epoch,
                offset,
                bytes,
            } => {
                if let Some(b) = self.bound_mut() {
                    b.output(cx, epoch, offset, &bytes);
                }
            }
            PanelMsg::TerminalReset {
                epoch,
                offset,
                formatted,
            } => {
                if let Some(b) = self.bound_mut() {
                    b.reset(epoch, offset, &formatted);
                }
            }
            PanelMsg::TerminalResetRequest { frames, bytes } => {
                if let Some(b) = self.bound_mut() {
                    b.notice = Some(Note::new(
                        Tone::Warning,
                        format!(
                            "Output was dropped ({frames} frames, {bytes} bytes). Asking the host for a repaint."
                        ),
                    ));
                    b.ask_repaint(cx);
                }
            }
            // The program's own word: stored, shown, and nothing else.
            PanelMsg::TerminalReport(report) => {
                if let Some(b) = self.bound_mut() {
                    b.hold_report(report);
                }
            }
            PanelMsg::Action(id) => self.on_action(id, cx),
            PanelMsg::Workspace(identity) => self.adopt(&identity),
            PanelMsg::Tick => self.on_tick(cx),
            // `PanelMsg` is non-exhaustive: a message this pane has no use
            // for changes nothing.
            _ => {}
        }
        if !quiet {
            self.pump(cx);
        }
    }

    fn view(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        draw::view(self, area, buf, cx);
    }

    fn semantics(&self, area: Rect, cx: &ViewCtx) -> Vec<Node> {
        semantics::nodes(self, area, cx)
    }

    fn serialize(&self) -> Value {
        match &self.stage {
            Stage::Bound(b) => json!({
                "v": SAVED_VERSION,
                "session": b.session,
                "workspace": b.workspace,
                "backend": match b.backend {
                    TerminalBackend::Herdr => "herdr",
                    TerminalBackend::Native => "native",
                },
            }),
            Stage::Restoring(saved) => json!({
                "v": SAVED_VERSION,
                "session": saved.session,
                "workspace": saved.workspace,
                "backend": match saved.backend {
                    TerminalBackend::Herdr => "herdr",
                    TerminalBackend::Native => "native",
                },
            }),
            _ => json!({ "v": SAVED_VERSION }),
        }
    }

    fn binding(&self) -> Option<Binding> {
        let generation = match &self.stage {
            Stage::Bound(b) => Generation(b.epoch),
            Stage::Restoring(_) => Generation(0),
            _ => self.identity.generation,
        };
        Some(Binding {
            resource: self.resource(),
            revision: None,
            generation: Some(generation),
        })
    }

    fn text_entry(&self) -> bool {
        self.bound()
            .is_some_and(|b| b.running() && !b.attaching())
    }

    /// Escape belongs to the pane wherever it means something here: out of a
    /// failure or a wait, off an end prompt, or back from an ended program. Otherwise a drawer takes it and the pane
    /// vanishes with a failure unread. Nothing is typed in these states, so
    /// the pane's own key context stays.
    fn holds_escape(&self) -> bool {
        match &self.stage {
            Stage::Choosing => false,
            Stage::Restoring(_) | Stage::Opening(_) | Stage::Failed(_) => true,
            Stage::Bound(b) => {
                self.text_entry()
                    || b.end != EndAsk::No
                    || !b.running()
                    || b.gone
            }
        }
    }

    fn teardown(&mut self, cx: &mut Ctx, _destroy: bool) {
        // Closing a view detaches. It never ends the process, even when a
        // Destroy action is the one closing it: ending is its own action.
        self.flush_deferred(cx);
        match &self.stage {
            Stage::Bound(b) => {
                let claim = b.claim();
                let _ = b.emit(cx, EffectBody::TerminalDetach(claim));
            }
            // The open is still in flight: the session it creates has no
            // owner once this pane is gone, so the host is asked to undo it.
            Stage::Opening(op) => {
                let open = op.effect;
                let resource = ResourceRef::Workspace {
                    workspace: self.identity.workspace.clone(),
                };
                let generation = self.identity.generation;
                let _ = cx.emit(|id| {
                    Effect::new(
                        id,
                        resource,
                        EffectBody::TerminalAbandonOpen(TerminalAbandonOpen { open }),
                    )
                    .with_generation(generation)
                });
            }
            _ => {}
        }
    }
}

/// The terminal name the Herdr core accepts: 1 to 32 characters of `a-z 0-9 - _ .`,
/// unique among live terminals. The name is the profile id made readable plus
/// a short hash of `unique` (this binding's own prefix), so two opens of one
/// profile never collide. No safe name (an id with nothing ASCII in it) gives
/// `None` and the host names the terminal.
///
/// Hand-rolled on purpose: the only slug code in the lockfile is `heck`, a
/// transitive dependency that keeps non-ASCII letters and has no length or
/// uniqueness rule, so it would still need this filter around it.
pub(crate) fn terminal_name(profile_id: &str, unique: &str) -> Option<String> {
    use std::hash::{DefaultHasher, Hash, Hasher};
    const READABLE: usize = 23;
    let mut slug = String::new();
    for c in profile_id.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    let slug = &slug[..slug.len().min(READABLE)];
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        return None;
    }
    let mut hasher = DefaultHasher::new();
    unique.hash(&mut hasher);
    Some(format!("{slug}-{:08x}", hasher.finish() as u32))
}

#[cfg(test)]
mod tests {
    use super::terminal_name;

    fn valid(name: &str) -> bool {
        (1..=32).contains(&name.len())
            && name
                .chars()
                .all(|c| matches!(c, 'a'..='z' | '0'..='9' | '-' | '_' | '.'))
    }

    #[test]
    fn a_profile_id_becomes_a_readable_name_the_core_accepts() {
        let name = terminal_name("Herdr shell", "n1.p.1").unwrap();
        assert!(name.starts_with("herdr-shell-") && valid(&name), "{name}");
        let name = terminal_name("Claude Code (Herdr)", "n1.p.1").unwrap();
        assert!(
            name.starts_with("claude-code-herdr-") && valid(&name),
            "{name}"
        );
    }

    #[test]
    fn uppercase_punctuation_and_non_ascii_never_reach_the_name() {
        for id in [
            "ZSH",
            "a/b\\c:d*e?f",
            "caf\u{e9} shell",
            "x\ty\nz",
            "  lead and trail  ",
            "--a--",
        ] {
            let name = terminal_name(id, "u").unwrap();
            assert!(valid(&name), "{id:?} gave {name:?}");
            assert!(!name.contains("--") && !name.starts_with('-'), "{name}");
        }
        assert!(terminal_name("caf\u{e9}", "u").unwrap().starts_with("caf-"));
    }

    #[test]
    fn an_id_with_nothing_usable_gets_no_name_instead_of_a_failing_one() {
        for id in [
            "",
            " ",
            "\u{65e5}\u{672c}\u{8a9e}",
            "---",
            "!!!",
            "\u{1f600}",
        ] {
            assert_eq!(terminal_name(id, "u"), None, "{id:?}");
        }
    }

    #[test]
    fn a_very_long_id_is_cut_to_fit_with_its_suffix_inside_32() {
        let name = terminal_name(&"a".repeat(500), "u").unwrap();
        assert_eq!(name.len(), 32, "{name}");
        assert!(valid(&name));
        // A cut that lands on a separator does not leave a doubled one.
        let id = format!("{} b", "a".repeat(22));
        let name = terminal_name(&id, "u").unwrap();
        assert!(valid(&name) && !name.contains("--"), "{name}");
    }

    #[test]
    fn two_opens_of_one_profile_get_different_names() {
        assert_ne!(
            terminal_name("Herdr shell", "n1.p.1"),
            terminal_name("Herdr shell", "n1.p.2")
        );
        assert_eq!(
            terminal_name("Herdr shell", "n1.p.1"),
            terminal_name("Herdr shell", "n1.p.1")
        );
    }
}

/// The control table's key for a bound terminal.
pub(crate) fn control_key(b: &Bound) -> crate::control::Key {
    crate::control::Key {
        workspace: b.workspace.clone(),
        session: b.session.clone(),
    }
}

/// The person's own input reached the terminal: an agent holding its claim
/// stops (IN-03), and the pane says so.
fn took_over(catalog: &Catalog, b: &mut Bound) {
    if catalog.control().person_input(&control_key(b), b.epoch) {
        b.notice = Some(Note::new(
            Tone::Warning,
            "You took over from the agent. It sends no more input here until you hand it back.",
        ));
    }
}
