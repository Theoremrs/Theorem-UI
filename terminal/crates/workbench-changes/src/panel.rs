//! The Changes panel mounted in the workbench: the model behind the core's `Panel` trait.
//!
//! Written for this crate; not translated. The model decides everything (what a key
//! means for the list, what may be asked, what an answer changes); this file only turns
//! keys, the pointer and completions into calls on it, sends each request it returns as
//! an effect, and gives the answer back. Text entry (the commit subject and body, the
//! branch prompt) is `tui-input`, as the Files panel's rename row is.
//!
//! The panel is bound to the workspace's repository (`ResourceRef::Repository`) at the
//! model's generation: an effect carries the generation its request was decided against,
//! so the core drops an answer for a repository state the panel has left, and the model
//! drops one it was never going to apply.

use std::collections::BTreeMap;

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use serde_json::Value;
use theorem_workbench_core::completion::{Completion, Outcome};
use theorem_workbench_core::effect::{Effect, ScmRef};
use theorem_workbench_core::host::{ConnectionState, HostMessage};
use theorem_workbench_core::ids::{
    ActionId, Capability, EffectId, Generation, ResourceRef, WorkspaceIdentity,
};
use theorem_workbench_core::registry::Capabilities;
use theorem_workbench_core::semantics::Node;
use theorem_workbench_core::stale::Binding;
use theorem_workbench_core::{
    Button, Ctx, OpenTarget, Panel, PanelFactories, PanelMsg, PanelPointer, PointerKind, ViewCtx,
};
use tui_input::{Input, InputRequest};

use crate::descriptors::AMEND_CAPABILITY;
use crate::intent::{ActionKind, Intent, IntentId, Refusal, Side};
use crate::layout::{Control, Hit, Verb};
use crate::model::{Caret, Changes, Field, Focus, Mode, PromptKind};
use crate::semantics::actions;
use crate::status::Section;
use crate::styles::ChangesStyles;
use crate::view_state::ViewState;

/// The kind the core's builtin registry gives the Changes tool.
pub const KIND: &str = "changes";

/// The repository the panel is bound to: the workspace's own root. The wire names a
/// repository by its root path and the owner has one per workspace, so this is the root.
pub const REPOSITORY: &str = "";

/// Registers the panel under the builtin kind `"changes"`.
pub fn register(factories: &mut PanelFactories) {
    factories.register(KIND, |state, _version| {
        Box::new(ChangesPanel::restore(state))
    });
}

/// The panel. Public so a host can build one directly; the workbench builds it through
/// [`register`].
pub struct ChangesPanel {
    model: Changes,
    identity: WorkspaceIdentity,
    /// The size the panel was last laid out at; pointer positions are within it.
    area: Rect,
    /// The panel has been laid out with room: until then it is not shown and reads nothing.
    shown: bool,
    /// A status read is owed: the first one, or one the host's messages asked for.
    read_due: bool,
    /// The host offers source control.
    scm_ok: bool,
    connection: Option<ConnectionState>,
    /// The request each effect carries.
    sent: BTreeMap<EffectId, IntentId>,
    subject: Input,
    /// The body's lines; never empty.
    body: Vec<Input>,
    /// The body line being edited, and whether the edit is in the body at all.
    row: usize,
    in_body: bool,
    prompt: Option<Input>,
    /// An amend was asked for by action and waits for the log to name the last message.
    amend_send: bool,
}

/// A page of lines for the page keys.
const PAGE: isize = 10;
/// Far enough to reach either end of any list.
const EDGE: isize = 1_000_000;

/// The text-buffer request a key makes, when it edits text.
fn request(key: &KeyInput) -> Option<InputRequest> {
    let mods = key.mods();
    let word = mods.intersects(Mods::ALT | Mods::CTRL);
    Some(match key.key() {
        Key::Left if word => InputRequest::GoToPrevWord,
        Key::Right if word => InputRequest::GoToNextWord,
        Key::Left => InputRequest::GoToPrevChar,
        Key::Right => InputRequest::GoToNextChar,
        Key::Home => InputRequest::GoToStart,
        Key::End => InputRequest::GoToEnd,
        Key::Backspace if word => InputRequest::DeletePrevWord,
        Key::Backspace => InputRequest::DeletePrevChar,
        Key::Delete => InputRequest::DeleteNextChar,
        Key::Char(c) if mods.intersects(Mods::CTRL | Mods::CMD) => match c {
            'a' => InputRequest::GoToStart,
            'e' => InputRequest::GoToEnd,
            'u' => InputRequest::DeleteFromStart,
            'k' => InputRequest::DeleteTillEnd,
            _ => return None,
        },
        Key::Char(c) if mods.difference(Mods::SHIFT).is_empty() => InputRequest::InsertChar(c),
        _ => return None,
    })
}

fn at_column(input: &Input, column: usize) -> Input {
    Input::new(input.value().to_owned()).with_cursor(column)
}

impl ChangesPanel {
    pub fn restore(state: &Value) -> Self {
        let mut model = Changes::new();
        // A saved amend box is kept until the first message says what the host offers.
        model.set_amend_available(true);
        if let Ok(saved) = serde_json::from_value::<ViewState>(state.clone()) {
            model.restore(&saved);
        }
        let mut panel = Self {
            model,
            identity: WorkspaceIdentity::default(),
            area: Rect::default(),
            shown: false,
            read_due: true,
            scm_ok: true,
            connection: None,
            sent: BTreeMap::new(),
            subject: Input::default(),
            body: vec![Input::default()],
            row: 0,
            in_body: false,
            prompt: None,
            amend_send: false,
        };
        panel.load_inputs();
        panel
    }

    /// The model, for a host that reads it.
    /// The documents the editor has open, whole list each time (see
    /// [`Changes::set_documents`]). The host builds it from the document panels: a
    /// panel's path, whether its tab says it is modified, and the revision the owner
    /// last saved.
    pub fn set_documents(&mut self, documents: impl IntoIterator<Item = crate::OpenDocument>) {
        self.model.set_documents(documents);
    }

    pub fn model(&self) -> &Changes {
        &self.model
    }

    fn resource(&self) -> ResourceRef {
        ResourceRef::Repository {
            workspace: self.identity.workspace.clone(),
            repository: REPOSITORY.to_owned(),
        }
    }

    // ---- text buffers ------------------------------------------------------

    /// Puts the model's draft into the text buffers, the cursor at the end.
    fn load_inputs(&mut self) {
        self.subject = Input::new(self.model.subject().to_owned());
        self.load_body();
        self.mark_caret();
    }

    fn load_body(&mut self) {
        let lines: Vec<Input> = self
            .model
            .body()
            .split('\n')
            .map(|l| Input::new(l.to_owned()))
            .collect();
        self.row = self.row.min(lines.len() - 1);
        self.body = lines;
    }

    fn joined_body(&self) -> String {
        self.body
            .iter()
            .map(|i| i.value())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Brings the buffers back in line with the model after an answer changed the draft
    /// (a commit cleared it).
    fn sync_inputs(&mut self) {
        if self.subject.value() != self.model.subject() {
            self.subject = Input::new(self.model.subject().to_owned());
        }
        if self.joined_body() != self.model.body() {
            self.load_body();
        }
        self.mark_caret();
    }

    /// Tells the model what was typed, and where the caret is.
    fn edited(&mut self) {
        self.model.set_subject(self.subject.value());
        let body = self.joined_body();
        self.model.set_body(body);
        if let Some(prompt) = &self.prompt {
            self.model.set_prompt_text(prompt.value());
        }
        self.mark_caret();
    }

    fn mark_caret(&mut self) {
        let caret = if let Some(prompt) = &self.prompt {
            Some(Caret {
                field: Field::Prompt,
                row: 0,
                col: prompt.visual_cursor(),
            })
        } else if self.model.focus() == Focus::Message {
            Some(if self.in_body {
                Caret {
                    field: Field::Body,
                    row: self.row,
                    col: self.body[self.row].visual_cursor(),
                }
            } else {
                Caret {
                    field: Field::Subject,
                    row: 0,
                    col: self.subject.visual_cursor(),
                }
            })
        } else {
            None
        };
        self.model.set_caret(caret);
    }

    fn focus_message(&mut self, body: bool, row: usize) {
        self.model.set_focus(Focus::Message);
        self.in_body = body;
        self.row = row.min(self.body.len() - 1);
        self.mark_caret();
    }

    // ---- the workspace -----------------------------------------------------

    /// Takes the workspace the root names. The first one the panel sees is the one its
    /// saved view state was for. Another one after that is another repository: nothing
    /// the panel knew applies, and it reads again. A change of generation alone keeps what
    /// is shown and reads again.
    fn adopt(&mut self, identity: &WorkspaceIdentity) {
        if self.identity == *identity {
            return;
        }
        let was_set = self.identity.is_set();
        let moved = was_set
            && (self.identity.workspace != identity.workspace
                || self.identity.environment != identity.environment);
        if moved {
            let amend = self.model.amend_available();
            self.model = Changes::new();
            self.model.set_amend_available(amend);
            self.amend_send = false;
            self.sent.clear();
            self.prompt = None;
            self.row = 0;
            self.in_body = false;
            self.connection = None;
            self.load_inputs();
        }
        self.identity = identity.clone();
        if was_set {
            self.read_due = true;
        }
    }

    // ---- sending -----------------------------------------------------------

    /// Answers a request that never left the panel, in the owner's words for a refusal.
    fn not_sent(&mut self, intent: &Intent, code: &str, reason: String) {
        let outcome = Outcome::Refused {
            code: code.to_owned(),
            reason,
        };
        // A refusal is followed by nothing.
        self.model.complete(intent.id, &outcome, None);
    }

    fn send(&mut self, cx: &mut Ctx, intent: Intent) -> bool {
        let body = intent.kind.effect_body();
        let resource = self.resource();
        let generation = intent.generation;
        match cx.emit(|id| Effect::new(id, resource, body).with_generation(Generation(generation)))
        {
            Ok(effect) => {
                self.sent.insert(effect, intent.id);
                true
            }
            Err(error) => {
                self.not_sent(&intent, "not_sent", error.to_string());
                false
            }
        }
    }

    fn send_all(&mut self, cx: &mut Ctx, intents: Vec<Intent>) {
        for intent in intents {
            self.send(cx, intent);
        }
    }

    /// Sends what a user action decided, if it decided to send.
    fn go(&mut self, cx: &mut Ctx, decision: Result<Intent, Refusal>) {
        if let Ok(intent) = decision {
            self.send(cx, intent);
        }
    }

    /// Starts the status read that is owed. Only once the panel is shown and the host
    /// names a workspace, never while another read runs, and never on the host's say-so
    /// while an unknown result waits for the person to read the state.
    fn pump(&mut self, cx: &mut Ctx) {
        if !(self.shown && self.read_due && self.identity.is_set() && self.scm_ok) {
            return;
        }
        if self.model.is_busy(ActionKind::Status) {
            return;
        }
        let first = self.model.groups().is_none() && self.model.status_problem().is_none();
        if !first && !self.model.unreconciled().is_empty() {
            return;
        }
        let intent = self.model.refresh();
        if self.send(cx, intent) {
            self.read_due = false;
        }
    }

    fn on_completion(&mut self, completion: Completion, cx: &mut Ctx) {
        let Some(intent) = self.sent.remove(&completion.effect) else {
            return;
        };
        let next = self
            .model
            .complete(intent, &completion.outcome, completion.payload.as_ref());
        self.sync_inputs();
        // A list that has rows has a cursor on the first, so a key acts on a row at once.
        if self.model.cursor().is_none() && self.model.groups().is_some() {
            self.model.move_cursor(0, false);
        }
        self.send_all(cx, next);
        // An amend asked for by action goes once the log has named the last message.
        if self.amend_send && !self.model.amend_waiting() {
            self.amend_send = false;
            if self.model.amend() {
                let d = self.model.commit();
                self.go(cx, d);
            }
        }
    }

    /// Takes what the host offers from the context: scm to read at all, and the amend
    /// capability for the amend box. A host that gains scm is read again.
    fn take_capabilities(&mut self, capabilities: &Capabilities) {
        let scm = capabilities.has(&Capability::new("scm"));
        if scm && !self.scm_ok {
            self.read_due = true;
        }
        self.scm_ok = scm;
        let amend = capabilities.has(&Capability::new(AMEND_CAPABILITY));
        self.model.set_amend_available(amend);
    }

    /// What the view context says the host offers, for what is drawn and described.
    fn show_capabilities(&self, cx: &ViewCtx) {
        self.model
            .show_amend_available(cx.capabilities().has(&Capability::new(AMEND_CAPABILITY)));
    }

    fn on_host(&mut self, message: HostMessage) {
        let workspace = self.identity.workspace.clone();
        match message {
            HostMessage::FileChanged { workspace: w, .. }
            | HostMessage::Resync { workspace: w, .. }
                if w == workspace =>
            {
                self.read_due = true;
            }
            HostMessage::ConnectionChanged {
                workspace: w,
                state,
            } if w == workspace => {
                if state == ConnectionState::Open && self.connection != Some(state) {
                    self.read_due = true;
                }
                self.connection = Some(state);
            }
            // Another workspace's, the root's own (it tells the panel of a new workspace
            // as `PanelMsg::Workspace`), or another kind of panel's.
            HostMessage::FileChanged { .. }
            | HostMessage::Resync { .. }
            | HostMessage::ConnectionChanged { .. }
            | HostMessage::DocumentChanged { .. }
            | HostMessage::DocumentAcknowledged { .. }
            | HostMessage::DocumentResync { .. }
            | HostMessage::DocumentConflict { .. }
            | HostMessage::DocumentSaved { .. }
            | HostMessage::DocumentMoved { .. }
            | HostMessage::DocumentRetired { .. }
            | HostMessage::TerminalOutput { .. }
            | HostMessage::TerminalReset { .. }
            | HostMessage::TerminalResized { .. }
            | HostMessage::TerminalOpened { .. }
            | HostMessage::TerminalExited { .. }
            | HostMessage::CapabilitiesChanged { .. }
            | HostMessage::TerminalControl { .. }
            | HostMessage::TerminalSessions { .. }
            | HostMessage::ConversationSnapshot { .. }
            | HostMessage::ThemeChanged { .. }
            | HostMessage::WorkspaceChanged { .. } => {}
            _ => {}
        }
    }

    // ---- what the user can ask for ----------------------------------------

    fn toggle_diff(&mut self, cx: &mut Ctx) {
        if let Ok(Some(intent)) = self.model.toggle_diff() {
            self.send(cx, intent);
        }
    }

    /// Reads the cursor file's diff: opens it, or reads it again.
    fn read_diff(&mut self, cx: &mut Ctx) {
        let Some(key) = self.model.cursor().cloned() else {
            return;
        };
        let asked = if self.model.diff(&key).is_some() {
            self.model.reload_diff(&key)
        } else {
            self.model.toggle_diff_of(&key)
        };
        if let Ok(Some(intent)) = asked {
            self.send(cx, intent);
        }
    }

    fn commit(&mut self, cx: &mut Ctx) {
        let nothing_staged = self
            .model
            .groups()
            .is_some_and(|g| g.staged.is_empty() && !g.unstaged.is_empty());
        let decision = if nothing_staged && !self.model.amend() {
            self.model.commit_staging_all()
        } else {
            self.model.commit()
        };
        self.go(cx, decision);
    }

    fn refresh(&mut self, cx: &mut Ctx) {
        let intent = self.model.refresh();
        if self.send(cx, intent) {
            self.read_due = false;
        }
    }

    fn request_log(&mut self, cx: &mut Ctx) {
        if let Some(intent) = self.model.request_log() {
            self.send(cx, intent);
        }
    }

    fn confirm(&mut self, cx: &mut Ctx) {
        if let Ok(intents) = self.model.confirm() {
            self.send_all(cx, intents);
        }
    }

    fn restore_last(&mut self, cx: &mut Ctx) {
        if let Ok(Some(intent)) = self.model.restore_last() {
            self.send(cx, intent);
        }
    }

    /// Opens the prompt. A switch and a merge also ask for the branch list.
    fn open_prompt(&mut self, kind: PromptKind, cx: &mut Ctx) {
        if let Ok(list) = self.model.open_prompt(kind) {
            self.prompt = Some(Input::default());
            self.mark_caret();
            if let Some(intent) = list {
                self.send(cx, intent);
            }
        }
    }

    fn close_prompt(&mut self) {
        self.prompt = None;
        self.model.cancel_prompt();
        self.mark_caret();
    }

    /// Turns the amend box on (reading the log first if the last message is not known) or
    /// off.
    fn toggle_amend(&mut self, cx: &mut Ctx) {
        if self.model.amend() {
            self.model.end_amend();
        } else if let Ok(Some(log)) = self.model.begin_amend() {
            self.send(cx, log);
        }
        self.sync_inputs();
    }

    /// The registered amend: amends the last commit with the draft, or with the last
    /// commit's own message when there is no draft.
    fn amend_action(&mut self, cx: &mut Ctx) {
        let ask = match self.model.begin_amend() {
            Ok(ask) => ask,
            Err(_) => return,
        };
        self.sync_inputs();
        if let Some(log) = ask {
            self.send(cx, log);
        }
        if self.model.amend_waiting() {
            self.amend_send = true;
            return;
        }
        let d = self.model.commit();
        self.go(cx, d);
    }

    fn open_commit(&mut self, cx: &mut Ctx) {
        let d = self.model.open_commit();
        self.go(cx, d);
    }

    fn show_at_commit(&mut self, cx: &mut Ctx) {
        let d = self.model.show_at_commit();
        self.go(cx, d);
    }

    /// Shows both sides of the conflicted file under the cursor.
    fn open_conflict(&mut self, cx: &mut Ctx) {
        let d = self.model.open_conflict();
        self.go(cx, d);
    }

    /// Asks before taking a side whole; the answer comes through the confirm.
    fn take_side(&mut self, side: Side) {
        let _ = self.model.take_side(side);
    }

    /// Opens the conflicted file in the editor, to merge it by hand.
    fn edit_conflict(&mut self, cx: &mut Ctx) {
        // A binary file has no text to merge by hand.
        if self.model.conflict_binary() {
            return;
        }
        if let Some(path) = self.model.conflict_path() {
            cx.open(OpenTarget::File {
                workspace: self.identity.workspace.clone(),
                path,
            });
        }
    }

    /// Enter on a row: a conflicted file shows its sides, any other expands its diff.
    fn enter_row(&mut self, cx: &mut Ctx) {
        if self.model.cursor().map(|k| k.section) == Some(Section::Conflicted) {
            self.open_conflict(cx);
        } else {
            self.toggle_diff(cx);
        }
    }

    /// Moves the cursor of whatever has it: a history's, the list's or the log's; any
    /// other read view scrolls.
    fn move_by(&mut self, delta: isize) {
        if self.model.mode() == Mode::Read {
            if self.model.commit_row_open() {
                self.model.move_read_cursor(delta);
            } else {
                self.model.scroll_by(delta);
            }
        } else {
            self.model.move_cursor(delta, false);
        }
    }

    /// Goes back one step: the prompt, else the question, else the read view.
    fn cancel(&mut self) {
        if self.prompt.is_some() {
            self.close_prompt();
        } else if self.model.confirm_pending().is_some() {
            self.model.cancel_confirm();
        } else if self.model.mode() == Mode::Read {
            self.model.close_read();
        }
    }

    fn open_file(&mut self, cx: &mut Ctx) {
        if let Some(path) = self.model.cursor_path()
            && !path.ends_with('/')
        {
            cx.open(OpenTarget::File {
                workspace: self.identity.workspace.clone(),
                path: path.to_owned(),
            });
        }
    }

    /// An action the registry delivered: a person's choice from the picker or palette,
    /// or the agent's request. A request that needs a name or an answer first opens the
    /// prompt or the question; nothing is sent until it is answered.
    fn on_action(&mut self, id: &ActionId, cx: &mut Ctx) {
        match id.as_str() {
            actions::REFRESH => self.refresh(cx),
            actions::DIFF => self.read_diff(cx),
            actions::STAGE => {
                let d = self.model.stage();
                self.go(cx, d)
            }
            actions::UNSTAGE => {
                let d = self.model.unstage();
                self.go(cx, d)
            }
            actions::STAGE_ALL => {
                let d = self.model.stage_all();
                self.go(cx, d)
            }
            actions::UNSTAGE_ALL => {
                let d = self.model.unstage_all();
                self.go(cx, d)
            }
            actions::DISCARD => {
                let _ = self.model.request_discard();
            }
            actions::CONFIRM => self.confirm(cx),
            actions::RESTORE => self.restore_last(cx),
            actions::COMMIT => {
                let d = self.model.commit();
                self.go(cx, d)
            }
            actions::COMMIT_ALL => {
                let d = self.model.commit_staging_all();
                self.go(cx, d)
            }
            actions::LOG => self.request_log(cx),
            actions::HISTORY => {
                let d = self.model.history();
                self.go(cx, d)
            }
            actions::BLAME => {
                let d = self.model.blame();
                self.go(cx, d)
            }
            actions::SHOW_HEAD => {
                let d = self.model.show(ScmRef::Head);
                self.go(cx, d)
            }
            actions::SHOW_INDEX => {
                let d = self.model.show(ScmRef::Index);
                self.go(cx, d)
            }
            actions::FETCH => {
                let d = self.model.fetch();
                self.go(cx, d)
            }
            actions::PUSH => {
                let d = self.model.push();
                self.go(cx, d)
            }
            actions::SWITCH_BRANCH => self.open_prompt(PromptKind::Switch, cx),
            actions::CREATE_BRANCH => self.open_prompt(PromptKind::Create, cx),
            actions::MERGE => self.open_prompt(PromptKind::Merge, cx),
            actions::AMEND => self.amend_action(cx),
            actions::OPEN_COMMIT => self.open_commit(cx),
            actions::SHOW_AT_COMMIT => self.show_at_commit(cx),
            actions::OPEN_CONFLICT => self.open_conflict(cx),
            actions::TAKE_OURS => self.take_side(Side::Ours),
            actions::TAKE_THEIRS => self.take_side(Side::Theirs),
            actions::EDIT_CONFLICT => self.edit_conflict(cx),
            actions::CURSOR_UP => self.move_by(-1),
            actions::CURSOR_DOWN => self.move_by(1),
            actions::NEXT_GROUP => {
                self.model.focus_next();
                self.mark_caret();
            }
            actions::FOCUS_FILES => {
                self.model.set_focus(Focus::Files);
                self.mark_caret();
            }
            actions::FOCUS_DRAFT => self.focus_message(false, 0),
            actions::TOGGLE_DIFF => self.toggle_diff(cx),
            actions::TOGGLE_SELECTED => self.model.toggle_selected(),
            actions::SELECT_ALL => self.model.select_all(),
            actions::TOGGLE_AMEND => self.toggle_amend(cx),
            actions::TOGGLE_LAYOUT => self.model.toggle_layout(),
            actions::TOGGLE_FOLD => self.model.toggle_fold(),
            actions::NEXT_HUNK => self.model.move_hunk(1),
            actions::PREVIOUS_HUNK => self.model.move_hunk(-1),
            actions::OPEN_FILE => self.open_file(cx),
            actions::CANCEL => self.cancel(),
            actions::DISMISS_NOTICES => self.model.dismiss_notices(),
            _ => {}
        }
    }

    // ---- keys --------------------------------------------------------------

    fn on_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        if self.prompt.is_some() {
            return self.prompt_key(key, cx);
        }
        if self.model.confirm_pending().is_some() {
            return self.confirm_key(key, cx);
        }
        if self.model.mode() == Mode::Read {
            return self.read_key(key, cx);
        }
        match self.model.focus() {
            Focus::Files => self.files_key(key, cx),
            Focus::Message => self.message_key(key, cx),
            Focus::Log => self.log_key(key, cx),
        }
    }

    fn prompt_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        match key.key() {
            Key::Esc => self.close_prompt(),
            // A refusal leaves the prompt open for another try: the model said why in a notice.
            Key::Enter => {
                if let Ok(intent) = self.model.submit_prompt() {
                    self.prompt = None;
                    self.mark_caret();
                    self.send(cx, intent);
                }
            }
            // The offered branches are chosen with the arrows; Tab writes the choice out.
            Key::Up => self.model.prompt_move(-1),
            Key::Down => self.model.prompt_move(1),
            Key::Tab => {
                if let Some(name) = self.model.prompt_complete() {
                    self.prompt = Some(Input::new(name));
                    self.mark_caret();
                }
            }
            _ => {
                if let (Some(input), Some(req)) = (&mut self.prompt, request(&key)) {
                    input.handle(req);
                    self.edited();
                }
            }
        }
    }

    fn confirm_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        match key.key() {
            Key::Enter => self.confirm(cx),
            Key::Char('y' | 'Y') => self.confirm(cx),
            Key::Esc | Key::Char('n' | 'N') => self.model.cancel_confirm(),
            _ => {}
        }
    }

    fn read_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        let history = self.model.commit_row_open();
        let conflict = self.model.conflict_view();
        match key.key() {
            Key::Esc | Key::Char('q') => self.model.close_read(),
            Key::Up if history => self.model.move_read_cursor(-1),
            Key::Down if history => self.model.move_read_cursor(1),
            Key::Enter if history => self.open_commit(cx),
            Key::Char('v') if history => self.show_at_commit(cx),
            Key::Char('o') if conflict => self.take_side(Side::Ours),
            Key::Char('t') if conflict => self.take_side(Side::Theirs),
            Key::Char('e') if conflict => self.edit_conflict(cx),
            Key::Up => self.model.scroll_by(-1),
            Key::Down => self.model.scroll_by(1),
            Key::PageUp => self.model.scroll_by(-PAGE),
            Key::PageDown => self.model.scroll_by(PAGE),
            Key::Home => self.model.scroll_by(-EDGE),
            Key::End => self.model.scroll_by(EDGE),
            _ => {}
        }
    }

    fn files_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        let mods = key.mods();
        let command = mods.intersects(Mods::CTRL | Mods::CMD);
        let extend = mods.contains(Mods::SHIFT);
        match key.key() {
            Key::Up => self.model.move_cursor(-1, extend),
            Key::Down => self.model.move_cursor(1, extend),
            Key::PageUp => self.model.move_cursor(-PAGE, extend),
            Key::PageDown => self.model.move_cursor(PAGE, extend),
            Key::Home => self.model.move_cursor(-EDGE, extend),
            Key::End => self.model.move_cursor(EDGE, extend),
            Key::Right => {
                if self
                    .model
                    .cursor()
                    .is_some_and(|k| self.model.diff(k).is_none())
                {
                    self.toggle_diff(cx);
                }
            }
            Key::Left => {
                if self
                    .model
                    .cursor()
                    .is_some_and(|k| self.model.diff(k).is_some())
                {
                    self.toggle_diff(cx);
                }
            }
            Key::Enter if command => self.commit(cx),
            Key::Enter => self.enter_row(cx),
            Key::Tab => {
                self.model.focus_next();
                self.mark_caret();
            }
            Key::Esc => self.model.dismiss_notices(),
            Key::F5 => self.refresh(cx),
            Key::Char(c) if command => {
                if c.eq_ignore_ascii_case(&'a') {
                    self.model.select_all();
                }
            }
            Key::Char(c) => {
                let c = if mods.contains(Mods::SHIFT) {
                    c.to_ascii_uppercase()
                } else {
                    c
                };
                self.files_char(c, cx);
            }
            _ => {}
        }
    }

    fn files_char(&mut self, c: char, cx: &mut Ctx) {
        match c {
            ' ' => self.model.toggle_selected(),
            'e' => self.edit_conflict(cx),
            's' => {
                let d = self.model.stage();
                self.go(cx, d);
            }
            'S' => {
                let d = self.model.stage_all();
                self.go(cx, d);
            }
            'u' => {
                let d = self.model.unstage();
                self.go(cx, d);
            }
            'U' => {
                let d = self.model.unstage_all();
                self.go(cx, d);
            }
            'd' => {
                let _ = self.model.request_discard();
            }
            'z' => self.restore_last(cx),
            'o' => self.open_file(cx),
            'c' => self.focus_message(false, 0),
            'a' => self.toggle_amend(cx),
            'C' => self.commit(cx),
            'r' => self.refresh(cx),
            'l' => {
                self.model.set_focus(Focus::Log);
                self.request_log(cx);
            }
            'f' => {
                let d = self.model.fetch();
                self.go(cx, d);
            }
            'p' => {
                let d = self.model.push();
                self.go(cx, d);
            }
            'b' => self.open_prompt(PromptKind::Switch, cx),
            'n' => self.open_prompt(PromptKind::Create, cx),
            'm' => self.open_prompt(PromptKind::Merge, cx),
            'B' => {
                let d = self.model.blame();
                self.go(cx, d);
            }
            'v' => {
                let d = self.model.show(ScmRef::Head);
                self.go(cx, d);
            }
            'V' => {
                let d = self.model.show(ScmRef::Index);
                self.go(cx, d);
            }
            'h' => {
                let d = self.model.history();
                self.go(cx, d);
            }
            't' => self.model.toggle_layout(),
            'x' => self.model.toggle_fold(),
            '[' => self.model.move_hunk(-1),
            ']' => self.model.move_hunk(1),
            _ => {}
        }
    }

    fn log_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        match key.key() {
            Key::Up => self.model.move_cursor(-1, false),
            Key::Down => self.model.move_cursor(1, false),
            Key::Enter => self.open_commit(cx),
            Key::Tab => {
                self.model.focus_next();
                self.mark_caret();
            }
            Key::Esc => self.model.set_focus(Focus::Files),
            Key::F5 => self.refresh(cx),
            Key::Char('r') => self.refresh(cx),
            _ => {}
        }
    }

    fn message_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        let command = key.mods().intersects(Mods::CTRL | Mods::CMD);
        match key.key() {
            Key::Esc => {
                self.model.set_focus(Focus::Files);
                self.mark_caret();
            }
            Key::Tab => {
                self.model.focus_next();
                self.mark_caret();
            }
            Key::Enter if command => self.commit(cx),
            Key::Enter => self.enter(),
            Key::Up => self.step_row(-1),
            Key::Down => self.step_row(1),
            Key::Backspace if self.in_body && self.body[self.row].cursor() == 0 => {
                self.join_up();
            }
            _ => {
                if let Some(req) = request(&key) {
                    let input = if self.in_body {
                        &mut self.body[self.row]
                    } else {
                        &mut self.subject
                    };
                    input.handle(req);
                    self.edited();
                }
            }
        }
    }

    /// Enter in the subject goes to the body; in the body it breaks the line.
    fn enter(&mut self) {
        if !self.in_body {
            self.in_body = true;
            self.row = 0;
        } else {
            let line = &self.body[self.row];
            let at = line.cursor();
            let value = line.value().to_owned();
            let head: String = value.chars().take(at).collect();
            let tail: String = value.chars().skip(at).collect();
            self.body[self.row] = Input::new(head);
            self.body
                .insert(self.row + 1, Input::new(tail).with_cursor(0));
            self.row += 1;
        }
        self.edited();
    }

    /// Backspace at the start of a body line joins it to the one above; on the first
    /// line it goes back to the subject.
    fn join_up(&mut self) {
        if self.row == 0 {
            self.in_body = false;
        } else {
            let line = self.body.remove(self.row);
            self.row -= 1;
            let above = self.body[self.row].value().to_owned();
            let column = above.chars().count();
            self.body[self.row] =
                Input::new(format!("{above}{}", line.value())).with_cursor(column);
        }
        self.edited();
    }

    /// Up and down between the subject and the body lines, keeping the column.
    fn step_row(&mut self, delta: isize) {
        let column = if self.in_body {
            self.body[self.row].cursor()
        } else {
            self.subject.cursor()
        };
        if !self.in_body {
            if delta > 0 {
                self.in_body = true;
                self.row = 0;
            }
        } else if delta < 0 {
            if self.row == 0 {
                self.in_body = false;
            } else {
                self.row -= 1;
            }
        } else if self.row + 1 < self.body.len() {
            self.row += 1;
        }
        let input = if self.in_body {
            &mut self.body[self.row]
        } else {
            &mut self.subject
        };
        *input = at_column(input, column);
        self.mark_caret();
    }

    fn insert_text(&mut self, text: &str) {
        if let Some(prompt) = &mut self.prompt {
            for c in text.chars().filter(|c| !c.is_control()) {
                prompt.handle(InputRequest::InsertChar(c));
            }
            return self.edited();
        }
        if self.model.focus() != Focus::Message || self.model.confirm_pending().is_some() {
            return;
        }
        let mut lines = text.replace("\r\n", "\n").replace('\r', "\n");
        if !self.in_body {
            // A subject is one line: what follows its first line goes to the body.
            let rest = match lines.split_once('\n') {
                Some((first, rest)) => {
                    let rest = rest.to_owned();
                    lines = first.to_owned();
                    Some(rest)
                }
                None => None,
            };
            for c in lines.chars().filter(|c| !c.is_control()) {
                self.subject.handle(InputRequest::InsertChar(c));
            }
            if let Some(rest) = rest {
                self.in_body = true;
                self.row = 0;
                self.type_into_body(&rest);
            }
        } else {
            self.type_into_body(&lines);
        }
        self.edited();
    }

    fn type_into_body(&mut self, text: &str) {
        for (at, piece) in text.split('\n').enumerate() {
            if at > 0 {
                self.enter();
            }
            for c in piece.chars().filter(|c| !c.is_control()) {
                self.body[self.row].handle(InputRequest::InsertChar(c));
            }
        }
    }

    // ---- the pointer -------------------------------------------------------

    fn on_pointer(&mut self, p: PanelPointer, cx: &mut Ctx) {
        match p.kind {
            PointerKind::Wheel { dy, .. } => self.model.scroll_by(isize::from(dy)),
            PointerKind::Down(Button::Left) => {
                if p.x < 0 || p.y < 0 {
                    return;
                }
                let area = Rect::new(0, 0, self.area.width, self.area.height);
                let hit = self.model.hit(area, p.x as u16, p.y as u16);
                self.press(hit, p, cx);
            }
            _ => {}
        }
    }

    fn press(&mut self, hit: Hit, p: PanelPointer, cx: &mut Ctx) {
        if self.prompt.is_some() {
            // A press on an offered branch takes it; anywhere else leaves the prompt.
            if let Hit::Branch(index) = hit {
                if let Ok(intent) = self.model.prompt_pick(index) {
                    self.prompt = None;
                    self.mark_caret();
                    self.send(cx, intent);
                }
                return;
            }
            self.close_prompt();
        }
        let command = p.mods.intersects(Mods::CTRL | Mods::CMD);
        let extend = p.mods.contains(Mods::SHIFT);
        match hit {
            Hit::Nothing => {}
            Hit::Control(Control::Branch) => self.open_prompt(PromptKind::Switch, cx),
            Hit::Control(Control::Fetch) => {
                let d = self.model.fetch();
                self.go(cx, d);
            }
            Hit::Control(Control::Push) => {
                let d = self.model.push();
                self.go(cx, d);
            }
            Hit::Confirm => self.confirm(cx),
            Hit::Cancel => self.model.cancel_confirm(),
            Hit::Banner(_) => {
                if self.model.confirm_pending().is_none() {
                    self.model.dismiss_notices();
                }
            }
            Hit::Header { section, all } => {
                if all {
                    let d = match section {
                        crate::status::Section::Staged => self.model.unstage_all(),
                        _ => self.model.stage_all(),
                    };
                    self.go(cx, d);
                }
            }
            Hit::File { key, caret, verb } => {
                if command {
                    self.model.select(&key, false);
                    self.model.toggle_selected();
                } else {
                    self.model.select(&key, extend);
                }
                if caret {
                    // The press that begins a double click already toggled it.
                    if p.clicks <= 1
                        && let Ok(Some(intent)) = self.model.toggle_diff_of(&key)
                    {
                        self.send(cx, intent);
                    }
                } else if let Some(verb) = verb {
                    self.verb(verb, &key, cx);
                } else if p.clicks >= 2 {
                    self.open_file(cx);
                }
            }
            Hit::Hunk { key, index, header } => {
                self.model.select_hunk(&key, index);
                if header && p.clicks <= 1 {
                    self.model.toggle_fold();
                }
            }
            Hit::Subject => self.focus_message(false, 0),
            Hit::Body(row) => self.focus_message(true, row.saturating_sub(1)),
            Hit::Button => self.commit(cx),
            Hit::Amend => self.toggle_amend(cx),
            Hit::Branch(_) => {}
            Hit::Commit(at) => {
                self.model.select_commit(at);
                if p.clicks >= 2 {
                    self.open_commit(cx);
                }
            }
            Hit::Log(at) => {
                self.model.select_log(at);
                if p.clicks >= 2 {
                    self.open_commit(cx);
                }
            }
        }
    }

    fn verb(&mut self, verb: Verb, key: &crate::status::RowKey, cx: &mut Ctx) {
        match verb {
            Verb::Diff => {
                if let Ok(Some(intent)) = self.model.toggle_diff_of(key) {
                    self.send(cx, intent);
                }
            }
            Verb::Stage => {
                let d = self.model.stage();
                self.go(cx, d);
            }
            Verb::Unstage => {
                let d = self.model.unstage();
                self.go(cx, d);
            }
            Verb::Discard => {
                let _ = self.model.request_discard();
            }
        }
    }
}

impl Panel for ChangesPanel {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        // The root's identity and capabilities are the truth, whichever message carries them.
        self.adopt(cx.workspace());
        self.take_capabilities(cx.capabilities());
        // The environment cannot start work, and a cached answer is not ours to show:
        // neither is followed by a read.
        let quiet = matches!(
            msg,
            PanelMsg::Resize { .. }
                | PanelMsg::Focus(_)
                | PanelMsg::Cached(_)
                | PanelMsg::Workspace(_)
                | PanelMsg::Documents(_)
        );
        match msg {
            PanelMsg::Key(key) => self.on_key(key, cx),
            PanelMsg::Text(text) | PanelMsg::Paste(text) => self.insert_text(&text),
            PanelMsg::Pointer(p) => self.on_pointer(p, cx),
            PanelMsg::Resize { area, .. } => {
                self.area = area;
                self.model.set_area(area.width, area.height);
                self.shown = area.width > 0 && area.height > 0;
            }
            PanelMsg::Completion(completion) => self.on_completion(completion, cx),
            PanelMsg::Host(message) => self.on_host(message),
            PanelMsg::Workspace(identity) => self.adopt(&identity),
            // The root tells which documents are open and which hold a draft.
            PanelMsg::Documents(documents) => {
                self.set_documents(documents.into_iter().map(|d| crate::OpenDocument {
                    path: d.path,
                    saved_revision: d.saved_revision,
                    unsaved: d.unsaved,
                }))
            }
            PanelMsg::Action(id) => self.on_action(&id, cx),
            // Focus changes the drawing (the root passes it in `ViewCtx`), not the state.
            // An answer for a workspace this panel left is not shown as the current one.
            PanelMsg::Focus(_) | PanelMsg::Cached(_) | PanelMsg::Tick => {}
            // The panel is bound to no terminal session.
            PanelMsg::TerminalOutput { .. }
            | PanelMsg::TerminalReset { .. }
            | PanelMsg::TerminalResetRequest { .. } => {}
            // A message added to the core after this panel was written.
            _ => {}
        }
        if !quiet {
            self.pump(cx);
        }
    }

    fn view(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        self.show_capabilities(cx);
        self.model
            .draw(area, buf, &ChangesStyles::from_theme(cx.theme));
    }

    fn semantics(&self, area: Rect, cx: &ViewCtx) -> Vec<Node> {
        self.show_capabilities(cx);
        let mut nodes = self.model.semantics("changes", area).nodes;
        let resource = self.resource();
        if let Some(root) = nodes.first_mut() {
            root.binding = resource;
        }
        nodes
    }

    fn serialize(&self) -> Value {
        serde_json::to_value(self.model.view_state()).unwrap_or(Value::Null)
    }

    /// Bound to the workspace's repository at the model's generation: the generation an
    /// effect carries is the one its request was decided against.
    fn binding(&self) -> Option<Binding> {
        Some(Binding {
            resource: self.resource(),
            revision: None,
            generation: Some(Generation(self.model.generation())),
        })
    }

    fn text_entry(&self) -> bool {
        self.prompt.is_some() || self.model.focus() == Focus::Message
    }
}
