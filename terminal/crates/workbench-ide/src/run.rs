//! The Run output panel: start a configured run, watch its state and output, stop it.
//!
//! The run owner has no event stream. It lists runs on request (`run.list`, when the host
//! grants it) so a run started elsewhere can be shown here by its handle. It answers `runPoll` with the host's
//! word for one run and everything the run wrote so far (not only what is new), so the panel
//! polls on its own ticks and replaces what it shows with each answer. It reads no clock: a
//! poll goes out every `POLL_EVERY` frames while the run is live, and an answer that says
//! the run has ended ends the polling. A refusal, failure or uncertain answer is shown in
//! the owner's words and pauses polling until the person asks again; nothing is retried
//! silently.
//!
//! Output arrives as UTF-8 text, never bytes, and stdout and stderr arrive apart, so the
//! panel shows stdout, then stderr under a rule, and says the wire is text. Colour survives
//! only where the host left escape sequences in the text, and `ansi-to-tui` turns those into
//! styles.
//!
//! Stopping is two steps. `run.stop` asks, and only `run.stop-confirm` (a human-only action,
//! as discard is in Changes) sends the stop. Closing the panel sends nothing: the run lives
//! in the host and the panel is only a view of it.

use std::collections::BTreeMap;

use ansi_to_tui::IntoText;
use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use theorem_workbench_core::completion::{Completion, CompletionPayload, Outcome};
use theorem_workbench_core::effect::{
    Effect, EffectBody, EffectKind, RunConfigure, RunHandle, RunStart,
};
use theorem_workbench_core::ids::{
    ActionId, Capability, EffectId, Generation, PanelKind, ResourceRef, WorkspaceIdentity,
};
use theorem_workbench_core::registry::{ActionDescriptor, ActionIntent};
use theorem_workbench_core::results::{RunState, RunSummary};
use theorem_workbench_core::semantics::{Node, NodeAction, Role};
use theorem_workbench_core::stale::Binding;
use theorem_workbench_core::{
    Button, Ctx, Panel, PanelFactories, PanelMsg, PanelPointer, PointerKind, TabLabel, ViewCtx,
};
use theorem_workbench_panels::caret::caret_text;

use crate::styles::Styles;
use crate::text;
use theorem_workbench_panels::clip::{FieldClip, Settled, finish_cut, not_done};
use theorem_workbench_text::field::{Field, FieldStyles, Keyed};

pub const KIND: &str = "run-output";
const START_CAPABILITY: &str = "run.start";
const READ_CAPABILITY: &str = "run.subscribe";
const LIST_CAPABILITY: &str = "run.list";

/// Frames between two polls of a live run.
const POLL_EVERY: u32 = 8;
const LABEL: u16 = 9;

/// The action ids of the panel, as `descriptors` registers them.
pub mod actions {
    pub const START: &str = "run.start";
    pub const STOP: &str = "run.stop";
    pub const STOP_CONFIRM: &str = "run.stop-confirm";
    pub const STOP_CANCEL: &str = "run.stop-cancel";
    pub const REFRESH: &str = "run.refresh";
    pub const LIST: &str = "run.list";
    pub const LIST_UP: &str = "run.list-up";
    pub const LIST_DOWN: &str = "run.list-down";
    pub const ATTACH: &str = "run.attach";
    pub const LIST_CLOSE: &str = "run.list-close";
    pub const FOLLOW: &str = "run.follow";
    pub const NEXT_FIELD: &str = "run.next-field";
    pub const SCROLL_UP: &str = "run.scroll-up";
    pub const SCROLL_DOWN: &str = "run.scroll-down";
    pub const SCROLL_END: &str = "run.scroll-end";
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ViewState {
    name: String,
    command: String,
    #[serde(default = "yes")]
    follow: bool,
    scroll: usize,
    /// The run the panel was showing. Restoring it only reads that run again.
    handle: Option<String>,
}

impl Default for ViewState {
    fn default() -> Self {
        Self {
            name: String::new(),
            command: String::new(),
            follow: true,
            scroll: 0,
            handle: None,
        }
    }
}

/// Registers the panel under the builtin kind `"run-output"`.
pub fn register(factories: &mut PanelFactories) {
    factories.register(KIND, |state, _version| Box::new(RunPanel::restore(state)));
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Focus {
    Name,
    Command,
    Output,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    Configure,
    Start,
    Poll,
    Stop,
    List,
}

/// Where the panel learned of the run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Origin {
    /// The panel started it.
    Here,
    /// The panel was given the handle: a run started elsewhere, or by this panel before it
    /// was restored.
    Observed,
}

/// The host's last word for the run.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Word {
    word: String,
    code: Option<i64>,
}

impl Word {
    /// The state in words for a person. A word the panel does not know is shown as the
    /// host said it.
    fn describe(&self) -> String {
        let code = self.code;
        match (self.word.as_str(), code) {
            ("running", _) => "running".to_owned(),
            ("starting" | "pending" | "queued", _) => "starting".to_owned(),
            ("exited" | "exit" | "completed" | "finished" | "done", Some(c)) => {
                format!("exited with code {c}")
            }
            ("exited" | "exit" | "completed" | "finished" | "done", None) => {
                "exited (no code given)".to_owned()
            }
            ("failed" | "error", Some(c)) => format!("failed (code {c})"),
            ("failed" | "error", None) => "failed".to_owned(),
            ("stopped" | "killed" | "cancelled" | "canceled" | "terminated", _) => {
                "stopped".to_owned()
            }
            ("unknown", _) => "state not reported by the host".to_owned(),
            (other, Some(c)) => format!("{other} (code {c})"),
            (other, None) => other.to_owned(),
        }
    }

    /// A run that may still write. An unknown word counts as live so the next poll can say.
    fn live(&self) -> bool {
        matches!(
            self.word.as_str(),
            "running" | "starting" | "pending" | "queued" | "unknown"
        )
    }

    fn running(&self) -> bool {
        matches!(
            self.word.as_str(),
            "running" | "starting" | "pending" | "queued"
        )
    }
}

enum Row {
    Rule(&'static str),
    Text(Line<'static>),
}

/// The runs the host listed, shown in place of the output until one is chosen or the list is
/// closed.
struct Picker {
    runs: Vec<RunSummary>,
    sel: usize,
    top: usize,
}

struct Told {
    outcome: &'static str,
    text: String,
}

pub struct RunPanel {
    name: Field,
    command: Field,
    focus: Focus,
    handle: Option<String>,
    origin: Origin,
    state: Option<Word>,
    stdout: String,
    stderr: String,
    rows: Vec<Row>,
    /// Escape sequences were present, so colour was drawn.
    colour: bool,
    follow: bool,
    top: usize,
    asking: bool,
    stopping: bool,
    /// The owner's last non-answer, as it said it.
    told: Option<Told>,
    notice: Option<String>,
    /// Polling is paused until the person asks, after an answer that was not a state.
    paused: bool,
    ticks: u32,
    pending: BTreeMap<EffectId, Step>,
    /// The clipboard writes a field's copy and cut keys have out.
    clip: FieldClip<Focus>,
    identity: WorkspaceIdentity,
    can_start: bool,
    can_read: bool,
    can_list: bool,
    picker: Option<Picker>,
    area: Rect,
}

impl RunPanel {
    pub fn restore(state: &Value) -> Self {
        let saved: ViewState = serde_json::from_value(state.clone()).unwrap_or_default();
        let mut panel = Self {
            name: Field::new(&saved.name),
            command: Field::new(&saved.command),
            focus: Focus::Name,
            origin: Origin::Observed,
            handle: saved.handle,
            state: None,
            stdout: String::new(),
            stderr: String::new(),
            rows: vec![],
            colour: false,
            follow: saved.follow,
            top: saved.scroll,
            asking: false,
            stopping: false,
            told: None,
            notice: None,
            paused: false,
            // A restored handle is read on the first frame rather than after a wait.
            ticks: POLL_EVERY,
            pending: BTreeMap::new(),
            clip: FieldClip::default(),
            identity: WorkspaceIdentity::default(),
            can_start: true,
            can_read: true,
            can_list: false,
            picker: None,
            area: Rect::default(),
        };
        panel.rebuild();
        panel
    }

    /// The rows the panel shows, for tests and hosts that size things by output.
    pub fn output_rows(&self) -> usize {
        self.rows.len()
    }

    fn live(&self) -> bool {
        self.state.as_ref().is_some_and(Word::live)
    }

    fn running(&self) -> bool {
        self.state.as_ref().is_some_and(Word::running)
    }

    fn busy_starting(&self) -> bool {
        self.pending
            .values()
            .any(|s| matches!(s, Step::Configure | Step::Start))
    }

    /// The layout for `area`, with as many status rows as the status line needs.
    fn lay(&self, area: Rect) -> Layout {
        let labels = self.chip_labels();
        let probe = layout(area, &labels, 1);
        let rows = text::wrap(&self.status().0, probe.status.width as usize, STATUS_ROWS)
            .len()
            .max(1);
        layout(area, &labels, rows as u16)
    }

    fn list_height(&self) -> usize {
        self.lay(self.area).list.height as usize
    }

    /// The first row shown when the tail is followed.
    fn bottom(&self) -> usize {
        self.rows.len().saturating_sub(self.list_height())
    }

    fn first_row(&self) -> usize {
        if self.follow {
            self.bottom()
        } else {
            self.top.min(self.bottom())
        }
    }

    // ---- what comes in ------------------------------------------------------------------

    fn adopt(&mut self, identity: &WorkspaceIdentity) {
        if self.identity == *identity {
            return;
        }
        let moved = self.identity.is_set()
            && (self.identity.workspace != identity.workspace
                || self.identity.environment != identity.environment);
        if moved {
            // A handle names a run of one workspace.
            self.handle = None;
            self.state = None;
            self.stdout.clear();
            self.stderr.clear();
            self.pending.clear();
            self.picker = None;
            self.asking = false;
            self.stopping = false;
            self.told = None;
            self.rebuild();
        }
        self.identity = identity.clone();
    }

    fn rebuild(&mut self) {
        let mut rows = vec![];
        let mut colour = false;
        for (title, body) in [("stdout", &self.stdout), ("stderr", &self.stderr)] {
            if body.is_empty() {
                continue;
            }
            if title == "stderr" {
                rows.push(Row::Rule("stderr"));
            }
            colour |= body.contains('\u{1b}');
            rows.extend(lines_of(body).into_iter().map(Row::Text));
        }
        self.rows = rows;
        self.colour = colour;
    }

    fn told(&mut self, step: &str, outcome: &Outcome) {
        let (kind, text) = match outcome {
            Outcome::Refused { code, reason } => {
                ("refused", format!("{step} refused ({code}): {reason}"))
            }
            Outcome::Failed { reason } => ("failed", format!("{step} failed: {reason}")),
            Outcome::Uncertain { reason } => (
                "uncertain",
                format!("{step}: unknown whether it happened: {reason}"),
            ),
            Outcome::Accepted => return,
        };
        self.told = Some(Told {
            outcome: kind,
            text,
        });
    }

    fn on_completion(&mut self, completion: Completion, cx: &mut Ctx) {
        match self.clip.settle(&completion) {
            Some(Settled::Cut(focus, text)) => {
                if let Some(field) = self.field_in(focus) {
                    finish_cut(field, &text);
                }
                return;
            }
            Some(Settled::Not { cut, outcome }) => {
                self.notice = Some(not_done(cut, &outcome));
                return;
            }
            Some(Settled::Copied) => return,
            None => {}
        }
        let Some(step) = self.pending.remove(&completion.effect) else {
            return;
        };
        match (step, &completion.outcome, completion.payload) {
            (Step::Configure, Outcome::Accepted, _) => {
                let name = self.name.value().trim().to_owned();
                self.send(cx, Step::Start, EffectBody::RunStart(RunStart { name }));
            }
            (Step::Start, Outcome::Accepted, Some(CompletionPayload::RunStarted(started))) => {
                self.handle = Some(started.handle);
                self.origin = Origin::Here;
                self.state = Some(Word {
                    word: "starting".to_owned(),
                    code: None,
                });
                self.stdout.clear();
                self.stderr.clear();
                self.rebuild();
                self.follow = true;
                self.paused = false;
                self.poll(cx);
            }
            (Step::Start, Outcome::Accepted, _) => {
                self.notice = Some(
                    "The host accepted the start but sent no run handle, so there is nothing to read."
                        .to_owned(),
                );
            }
            (Step::Poll, Outcome::Accepted, Some(CompletionPayload::RunState(state))) => {
                self.ingest(state);
            }
            (Step::Poll, Outcome::Accepted, _) => {
                self.paused = true;
                self.notice = Some("The host answered the read with no run state.".to_owned());
            }
            (Step::List, Outcome::Accepted, Some(CompletionPayload::RunList(list))) => {
                let mut runs = list.runs;
                // Newest first; the host's own order breaks ties.
                runs.sort_by_key(|r| std::cmp::Reverse(r.started_at_ms.unwrap_or(0)));
                if runs.is_empty() {
                    self.picker = None;
                    self.notice = Some("The host lists no runs.".to_owned());
                } else {
                    self.picker = Some(Picker {
                        runs,
                        sel: 0,
                        top: 0,
                    });
                }
            }
            (Step::List, Outcome::Accepted, _) => {
                self.notice = Some("The host answered the list with no runs.".to_owned());
            }
            (Step::Stop, Outcome::Accepted, _) => {
                // The next frame reads the run to see it end.
                self.ticks = POLL_EVERY;
            }
            (step, outcome, _) => {
                let word = match step {
                    Step::Configure => "Setting the command",
                    Step::Start => "Starting the run",
                    Step::Poll => "Reading the run",
                    Step::Stop => "Stopping the run",
                    Step::List => "Listing the runs",
                };
                self.told(word, outcome);
                if step == Step::Poll {
                    self.paused = true;
                }
                if step == Step::Stop {
                    self.stopping = false;
                }
            }
        }
    }

    fn ingest(&mut self, state: RunState) {
        if self.handle.as_deref() != Some(state.handle.as_str()) {
            return;
        }
        if state.read_at.workspace_id != self.identity.workspace
            && !state.read_at.workspace_id.is_empty()
        {
            // An answer read at another workspace is not this run's.
            return;
        }
        let ended = !matches!(
            state.state.as_str(),
            "running" | "starting" | "pending" | "queued" | "unknown"
        );
        self.told = None;
        self.notice = None;
        self.state = Some(Word {
            word: state.state,
            code: state.exit_code,
        });
        if ended {
            self.stopping = false;
        }
        if self.stdout != state.stdout || self.stderr != state.stderr {
            self.stdout = state.stdout;
            self.stderr = state.stderr;
            self.rebuild();
        }
    }

    // ---- what goes out ------------------------------------------------------------------

    fn send(&mut self, cx: &mut Ctx, step: Step, body: EffectBody) -> bool {
        let resource = ResourceRef::Workspace {
            workspace: self.identity.workspace.clone(),
        };
        let generation = self.identity.generation;
        match cx.emit(|id| Effect::new(id, resource, body).with_generation(generation)) {
            Ok(id) => {
                self.pending.insert(id, step);
                true
            }
            Err(error) => {
                self.notice = Some(format!("Not sent: {error}."));
                false
            }
        }
    }

    fn poll(&mut self, cx: &mut Ctx) {
        let Some(handle) = self.handle.clone() else {
            return;
        };
        self.ticks = 0;
        self.send(cx, Step::Poll, EffectBody::RunPoll(RunHandle { handle }));
    }

    fn polling(&self) -> bool {
        self.pending.values().any(|s| *s == Step::Poll)
    }

    fn on_tick(&mut self, cx: &mut Ctx) {
        if !self.can_read
            || !self.identity.is_set()
            || self.handle.is_none()
            || self.paused
            || self.polling()
            || !(self.state.is_none() || self.live())
        {
            return;
        }
        self.ticks = self.ticks.saturating_add(1);
        if self.ticks >= POLL_EVERY {
            self.poll(cx);
        }
    }

    fn start(&mut self, cx: &mut Ctx) {
        self.notice = None;
        self.told = None;
        if !self.can_start {
            self.notice = Some(self.unavailable_start());
            return;
        }
        if !self.identity.is_set() {
            self.notice = Some("No workspace is open yet.".to_owned());
            return;
        }
        if self.busy_starting() {
            self.notice = Some("A start is already on its way.".to_owned());
            return;
        }
        if self.live() {
            self.notice = Some(
                "A run is live. Stop it before starting another: this panel shows one run."
                    .to_owned(),
            );
            return;
        }
        let name = self.name.value().trim().to_owned();
        if name.is_empty() {
            self.notice = Some("Name the run first.".to_owned());
            self.focus = Focus::Name;
            return;
        }
        self.paused = false;
        let command = self.command.value().trim().to_owned();
        if command.is_empty() {
            self.send(cx, Step::Start, EffectBody::RunStart(RunStart { name }));
            return;
        }
        match shlex::split(&command) {
            Some(argv) if !argv.is_empty() => {
                self.send(
                    cx,
                    Step::Configure,
                    EffectBody::RunConfigure(RunConfigure { name, argv }),
                );
            }
            _ => {
                self.notice =
                    Some("The command has an unclosed quote or no words in it.".to_owned());
                self.focus = Focus::Command;
            }
        }
    }

    fn ask_stop(&mut self) {
        self.notice = None;
        if !self.can_start {
            self.notice = Some(self.unavailable_start());
        } else if !self.running() || self.handle.is_none() {
            self.notice = Some("Nothing is running.".to_owned());
        } else if self.stopping {
            self.notice = Some("A stop is already on its way.".to_owned());
        } else {
            self.asking = true;
        }
    }

    fn confirm_stop(&mut self, cx: &mut Ctx) {
        if !self.asking {
            return;
        }
        self.asking = false;
        let Some(handle) = self.handle.clone() else {
            return;
        };
        if self.send(cx, Step::Stop, EffectBody::RunStop(RunHandle { handle })) {
            self.stopping = true;
        }
    }

    fn list(&mut self, cx: &mut Ctx) {
        self.notice = None;
        self.told = None;
        if !self.can_list {
            return;
        }
        if self.pending.values().any(|s| *s == Step::List) {
            self.notice = Some("A list is already on its way.".to_owned());
        } else if !self.identity.is_set() {
            self.notice = Some("No workspace is open yet.".to_owned());
        } else {
            self.send(cx, Step::List, EffectBody::RunList);
        }
    }

    fn move_pick(&mut self, delta: isize) {
        let height = self.list_height().saturating_sub(1).max(1);
        let Some(p) = &mut self.picker else {
            return;
        };
        p.sel = (p.sel as isize + delta).clamp(0, p.runs.len() as isize - 1) as usize;
        if p.sel < p.top {
            p.top = p.sel;
        } else if p.sel >= p.top + height {
            p.top = p.sel + 1 - height;
        }
    }

    /// Shows the listed run in this panel: its handle is read like any restored one. The run
    /// is not this panel's to stop or restart unless the person says so, and closing the view
    /// leaves it running.
    fn attach(&mut self, index: Option<usize>, cx: &mut Ctx) {
        let Some(picker) = self.picker.take() else {
            return;
        };
        let Some(run) = picker.runs.get(index.unwrap_or(picker.sel)) else {
            return;
        };
        if let Some(name) = &run.name {
            self.name = Field::new(name);
        }
        if let Some(argv) = &run.command
            && let Ok(line) = shlex::try_join(argv.iter().map(String::as_str))
        {
            self.command = Field::new(&line);
        }
        self.handle = Some(run.handle.clone());
        self.origin = Origin::Observed;
        self.state = Some(Word {
            word: run.state.clone(),
            code: None,
        });
        self.stdout.clear();
        self.stderr.clear();
        self.rebuild();
        self.follow = true;
        self.paused = false;
        self.asking = false;
        self.stopping = false;
        self.told = None;
        self.notice = None;
        self.focus = Focus::Output;
        if self.can_read {
            self.poll(cx);
        } else {
            self.notice = Some(self.unavailable_read());
        }
    }

    fn refresh(&mut self, cx: &mut Ctx) {
        self.notice = None;
        self.told = None;
        if !self.can_read {
            self.notice = Some(self.unavailable_read());
        } else if self.handle.is_none() {
            self.notice = Some("There is no run to read yet.".to_owned());
        } else if !self.polling() {
            self.paused = false;
            self.poll(cx);
        }
    }

    fn set_follow(&mut self, on: bool) {
        if on {
            self.follow = true;
        } else if self.follow {
            self.top = self.first_row();
            self.follow = false;
        }
    }

    /// Scrolls by `delta` rows. Up from the tail stops following; reaching the end follows
    /// again.
    fn scroll(&mut self, delta: isize) {
        let bottom = self.bottom();
        let from = self.first_row() as isize;
        let next = (from + delta).clamp(0, bottom as isize) as usize;
        if next >= bottom {
            self.top = bottom;
            self.follow = true;
        } else {
            self.top = next;
            self.follow = false;
        }
    }

    fn next_focus(&mut self, back: bool) {
        self.focus = match (self.focus, back) {
            (Focus::Name, false) => Focus::Command,
            (Focus::Command, false) => Focus::Output,
            (Focus::Output, false) => Focus::Name,
            (Focus::Name, true) => Focus::Output,
            (Focus::Command, true) => Focus::Name,
            (Focus::Output, true) => Focus::Command,
        };
    }

    fn field_mut(&mut self) -> Option<&mut Field> {
        self.field_in(self.focus)
    }

    fn field_in(&mut self, focus: Focus) -> Option<&mut Field> {
        match focus {
            Focus::Name => Some(&mut self.name),
            Focus::Command => Some(&mut self.command),
            Focus::Output => None,
        }
    }

    fn on_action(&mut self, id: &ActionId, cx: &mut Ctx) {
        match id.as_str() {
            actions::START => self.start(cx),
            actions::STOP => self.ask_stop(),
            actions::STOP_CONFIRM => self.confirm_stop(cx),
            actions::STOP_CANCEL => self.asking = false,
            actions::REFRESH => self.refresh(cx),
            actions::LIST => self.list(cx),
            actions::LIST_UP => self.move_pick(-1),
            actions::LIST_DOWN => self.move_pick(1),
            actions::ATTACH => self.attach(None, cx),
            actions::LIST_CLOSE => self.picker = None,
            actions::FOLLOW => self.set_follow(!self.follow),
            actions::NEXT_FIELD => self.next_focus(false),
            actions::SCROLL_UP => self.scroll(-(self.list_height().max(2) as isize - 1)),
            actions::SCROLL_DOWN => self.scroll(self.list_height().max(2) as isize - 1),
            actions::SCROLL_END => self.set_follow(true),
            _ => {}
        }
    }

    fn on_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        let mods = key.mods();
        // Ctrl+C asks to stop the run, unless a field has a selection: then it is the field's copy.
        let selected = self.field_mut().is_some_and(|f| f.selection().is_some());
        if mods.contains(Mods::CTRL) && key.key() == Key::Char('c') && !selected {
            return self.ask_stop();
        }
        if self.asking {
            match key.key() {
                Key::Enter | Key::Char('y') => self.confirm_stop(cx),
                Key::Esc | Key::Char('n') => self.asking = false,
                _ => {}
            }
            return;
        }
        if self.picker.is_some() {
            let page = self.list_height().saturating_sub(1).max(2) as isize - 1;
            match key.key() {
                Key::Up => self.move_pick(-1),
                Key::Down => self.move_pick(1),
                Key::PageUp => self.move_pick(-page),
                Key::PageDown => self.move_pick(page),
                Key::Home => self.move_pick(-1_000_000),
                Key::End => self.move_pick(1_000_000),
                Key::Enter => self.attach(None, cx),
                Key::Esc | Key::Char('l') => self.picker = None,
                _ => {}
            }
            return;
        }
        match key.key() {
            Key::Tab => return self.next_focus(mods.contains(Mods::SHIFT)),
            Key::Enter if self.focus != Focus::Output => return self.start(cx),
            Key::Esc => {
                self.focus = match self.focus {
                    Focus::Output => Focus::Command,
                    _ => Focus::Output,
                };
                return;
            }
            _ => {}
        }
        if self.focus != Focus::Output {
            let focus = self.focus;
            if let Some(field) = self.field_mut() {
                let keyed = field.key(&key);
                if matches!(keyed, Keyed::Copy | Keyed::Cut) {
                    let field = field.clone();
                    if let Some(note) = self.clip.ask(cx, focus, keyed, &field) {
                        self.notice = Some(note);
                    }
                }
            }
            return;
        }
        let page = self.list_height().max(2) as isize - 1;
        match key.key() {
            Key::Up => self.scroll(-1),
            Key::Down => self.scroll(1),
            Key::PageUp => self.scroll(-page),
            Key::PageDown => self.scroll(page),
            Key::Home => self.scroll(-1_000_000),
            Key::End => self.set_follow(true),
            Key::Char('f') if mods.is_empty() => self.set_follow(!self.follow),
            Key::Char('s') if mods.is_empty() => self.ask_stop(),
            Key::Char('r') if mods.is_empty() => self.refresh(cx),
            Key::Char('l') if mods.is_empty() && self.can_list => self.list(cx),
            Key::Char('g') if mods.is_empty() => self.start(cx),
            _ => {}
        }
    }

    fn on_pointer(&mut self, p: PanelPointer, cx: &mut Ctx) {
        let lay = self.lay(self.area);
        let (x, y) = (p.x, p.y);
        let inside = |r: Rect| {
            r.width > 0
                && x >= i32::from(r.x)
                && x < i32::from(r.x + r.width)
                && y >= i32::from(r.y)
                && y < i32::from(r.y + r.height)
        };
        match p.kind {
            PointerKind::Wheel { dy, .. } if self.picker.is_some() => {
                self.move_pick(isize::from(dy));
            }
            PointerKind::Wheel { dy, .. } => self.scroll(isize::from(dy) * 3),
            PointerKind::Down(Button::Left) => {
                for (focus, rect) in [(Focus::Name, lay.name), (Focus::Command, lay.command)] {
                    if inside(rect) {
                        self.focus = focus;
                        let column = (x - i32::from(rect.x)) as usize;
                        let shown = rect.width as usize;
                        if let Some(field) = self.field_mut() {
                            field.click(column, shown);
                        }
                        return;
                    }
                }
                if inside(lay.primary) {
                    return if self.asking {
                        self.confirm_stop(cx)
                    } else if self.running() {
                        self.ask_stop()
                    } else {
                        self.start(cx)
                    };
                }
                if inside(lay.secondary) {
                    self.asking = false;
                } else if inside(lay.runs) {
                    if self.picker.is_some() {
                        self.picker = None;
                    } else {
                        self.list(cx);
                    }
                } else if inside(lay.follow) {
                    self.set_follow(!self.follow);
                } else if inside(lay.list) {
                    self.focus = Focus::Output;
                    // The first row of the picker is its title; the runs follow it.
                    if let Some(p) = &self.picker {
                        let row = (y - i32::from(lay.list.y)) as usize;
                        if row >= 1 && p.top + row - 1 < p.runs.len() {
                            let at = p.top + row - 1;
                            self.attach(Some(at), cx);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    // ---- words ----------------------------------------------------------------------------

    fn unavailable_start(&self) -> String {
        format!(
            "Starting and stopping runs is unavailable: this host does not report the \"{START_CAPABILITY}\" capability."
        )
    }

    fn unavailable_read(&self) -> String {
        format!(
            "Run output cannot be read: this host does not report the \"{READ_CAPABILITY}\" capability."
        )
    }

    fn wire(&self) -> &'static str {
        if self.colour {
            "text, escape sequences drawn as colour"
        } else {
            "plain text"
        }
    }

    /// The status line and whether it is a problem.
    fn status(&self) -> (String, bool) {
        if !self.can_start && !self.can_read {
            return (
                format!(
                    "Runs are unavailable: this host reports neither \"{START_CAPABILITY}\" nor \"{READ_CAPABILITY}\"."
                ),
                true,
            );
        }
        if self.asking {
            return (
                "Stop the run? It will be ended and cannot be resumed. Enter or Yes stops it; Esc keeps it going."
                    .to_owned(),
                false,
            );
        }
        if let Some(told) = &self.told {
            return (format!("{} Not retried.", told.text), true);
        }
        if let Some(notice) = &self.notice {
            return (notice.clone(), true);
        }
        if self.busy_starting() {
            return ("Starting\u{2026}".to_owned(), false);
        }
        let Some(state) = &self.state else {
            return match &self.handle {
                Some(h) => (format!("Reading run {h}\u{2026}"), false),
                None => (
                    "No run yet. Name one, give a command if it is new, and press Enter."
                        .to_owned(),
                    false,
                ),
            };
        };
        let origin = match self.origin {
            Origin::Here => "started here",
            Origin::Observed => "observed, not started here",
        };
        let mut text = format!("{}, {origin}", state.describe());
        if self.stopping {
            text.push_str(", stop requested");
        }
        if self.paused {
            text.push_str(", reading paused");
        }
        if !self.rows.is_empty() || state.live() {
            text.push_str(&format!(", output is {}", self.wire()));
        }
        (text, false)
    }

    fn chip_labels(&self) -> ChipLabels {
        ChipLabels {
            primary: if self.asking {
                "[Yes, stop]"
            } else if self.running() {
                "[Stop]"
            } else {
                "[Start]"
            },
            secondary: if self.asking { "[Keep going]" } else { "" },
            runs: match (self.can_list, self.picker.is_some()) {
                (false, _) => "",
                (true, false) => "[Runs]",
                (true, true) => "[Close runs]",
            },
            follow: if self.follow {
                "[Following]"
            } else {
                "[Follow]"
            },
        }
    }

    fn actions_listed(&self) -> Vec<NodeAction> {
        let item = |id: &str, reason: Option<String>| NodeAction {
            id: ActionId::new(id),
            enabled: reason.is_none(),
            reason,
            title: None,
        };
        let start = if !self.can_start {
            Some(self.unavailable_start())
        } else if !self.identity.is_set() {
            Some("No workspace is open yet.".to_owned())
        } else if self.live() {
            Some("A run is live: stop it first.".to_owned())
        } else if self.name.value().trim().is_empty() {
            Some("The run has no name.".to_owned())
        } else {
            None
        };
        let stop = if !self.can_start {
            Some(self.unavailable_start())
        } else if !self.running() {
            Some("Nothing is running.".to_owned())
        } else if self.stopping {
            Some("A stop is already on its way.".to_owned())
        } else {
            None
        };
        let confirm = (!self.asking).then(|| "Ask to stop first with run.stop.".to_owned());
        let refresh = if !self.can_read {
            Some(self.unavailable_read())
        } else if self.handle.is_none() {
            Some("There is no run to read yet.".to_owned())
        } else {
            None
        };
        let scroll = self
            .rows
            .is_empty()
            .then(|| "There is no output to scroll.".to_owned());
        let list_reason = if self.picker.is_some() {
            None
        } else {
            Some("No run list is open.".to_owned())
        };
        let mut listed = vec![
            item(actions::START, start),
            item(actions::STOP, stop),
            item(actions::STOP_CONFIRM, confirm),
            item(
                actions::STOP_CANCEL,
                (!self.asking).then(|| "No stop was asked for.".to_owned()),
            ),
            item(actions::REFRESH, refresh),
            item(actions::FOLLOW, None),
            item(actions::NEXT_FIELD, None),
            item(actions::SCROLL_UP, scroll.clone()),
            item(actions::SCROLL_DOWN, scroll.clone()),
            item(actions::SCROLL_END, scroll),
        ];
        // Without the capability the control is absent, not disabled.
        if self.can_list {
            listed.push(item(
                actions::LIST,
                (!self.identity.is_set()).then(|| "No workspace is open yet.".to_owned()),
            ));
            listed.push(item(actions::LIST_UP, list_reason.clone()));
            listed.push(item(actions::LIST_DOWN, list_reason.clone()));
            listed.push(item(actions::ATTACH, list_reason.clone()));
            listed.push(item(actions::LIST_CLOSE, list_reason));
        }
        listed
    }

    // ---- drawing --------------------------------------------------------------------------

    fn draw(&self, area: Rect, buf: &mut Buffer, focused: bool, s: &Styles) {
        buf.set_style(area, s.text);
        let labels = self.chip_labels();
        let lay = self.lay(area);
        for (i, (name, focus, rect, field, placeholder)) in [
            ("Name", Focus::Name, lay.name, &self.name, "e.g. build"),
            (
                "Command",
                Focus::Command,
                lay.command,
                &self.command,
                "empty: start the run already configured under this name",
            ),
        ]
        .into_iter()
        .enumerate()
        {
            if (i as u16) < area.height {
                text::put(
                    buf,
                    area.x,
                    area.y + i as u16,
                    (LABEL as usize) - 1,
                    name,
                    s.muted,
                );
            }
            field.draw(
                buf,
                rect,
                &FieldStyles {
                    text: s.text,
                    selection: s.selection,
                    caret: s.cursor,
                    hint: s.muted,
                },
                focused && self.focus == focus,
                placeholder,
            );
        }
        let (words, problem) = self.status();
        let tone = if problem {
            s.error
        } else if self.running() {
            s.success
        } else {
            s.muted
        };
        for (i, line) in text::wrap(
            &words,
            lay.status.width as usize,
            lay.status.height as usize,
        )
        .iter()
        .enumerate()
        {
            text::put(
                buf,
                lay.status.x,
                lay.status.y + i as u16,
                lay.status.width as usize,
                line,
                tone,
            );
        }
        for (rect, label, style) in [
            (
                lay.primary,
                labels.primary,
                if self.asking { s.error } else { s.on },
            ),
            (lay.secondary, labels.secondary, s.on),
            (lay.runs, labels.runs, s.on),
            (
                lay.follow,
                labels.follow,
                if self.follow { s.on } else { s.muted },
            ),
        ] {
            if rect.width > 0 {
                text::put(buf, rect.x, rect.y, rect.width as usize, label, style);
            }
        }
        let list = lay.list;
        if let Some(p) = &self.picker {
            self.draw_picker(p, list, buf, focused, s);
            return;
        }
        let first = self.first_row();
        for y in 0..list.height {
            let Some(row) = self.rows.get(first + y as usize) else {
                break;
            };
            match row {
                Row::Rule(name) => {
                    let label = format!("\u{2500}\u{2500} {name} \u{2500}\u{2500}");
                    text::put(
                        buf,
                        list.x,
                        list.y + y,
                        list.width as usize,
                        &label,
                        s.muted,
                    );
                }
                Row::Text(line) => {
                    buf.set_line(list.x, list.y + y, &remap(line, &s.ansi), list.width);
                }
            }
        }
        if self.rows.is_empty() && list.height > 0 {
            let empty = if self.handle.is_some() && !self.live() {
                "The run wrote no output."
            } else if self.handle.is_some() {
                "No output yet."
            } else {
                ""
            };
            text::put(buf, list.x, list.y, list.width as usize, empty, s.muted);
        }
    }

    fn draw_picker(&self, p: &Picker, list: Rect, buf: &mut Buffer, focused: bool, s: &Styles) {
        if list.height == 0 {
            return;
        }
        let title = format!(
            "{} {} on the host. Enter shows one here; Esc closes the list.",
            p.runs.len(),
            if p.runs.len() == 1 { "run" } else { "runs" }
        );
        text::put(buf, list.x, list.y, list.width as usize, &title, s.muted);
        for (i, run) in p.runs.iter().enumerate().skip(p.top) {
            let y = list.y + 1 + (i - p.top) as u16;
            if y >= list.y + list.height {
                break;
            }
            let row = Rect::new(list.x, y, list.width, 1);
            let base = if i != p.sel {
                s.text
            } else if focused {
                s.cursor
            } else {
                s.cursor_idle
            };
            if i == p.sel {
                buf.set_style(row, base);
            }
            let line = run_row(run, row.width as usize, base, s, i == p.sel);
            buf.set_line(row.x, row.y, &line, row.width);
        }
    }

    fn nodes(&self, area: Rect, focused: bool) -> Vec<Node> {
        let lay = self.lay(area);
        let mut root = Node::new("run", Role::Log, "Run output", area);
        let (words, problem) = self.status();
        root.state.description = Some(words.clone());
        root.state.busy = self.running();
        root.state.focused = focused;
        root.actions = self.actions_listed();
        let mut out = vec![];
        let put = |root: &mut Node, node: Node, out: &mut Vec<Node>| {
            root.children.push(node.id.clone());
            out.push(node);
        };
        for (id, name, focus, rect, field) in [
            ("name", "Run name", Focus::Name, lay.name, &self.name),
            (
                "command",
                "Command and arguments",
                Focus::Command,
                lay.command,
                &self.command,
            ),
        ] {
            let mut node = Node::new(id, Role::TextBox, name, rect);
            caret_text(field.value(), field.anchor(), field.cursor()).put(&mut node);
            node.state.focused = focused && self.focus == focus;
            put(&mut root, node, &mut out);
        }
        let button = |id: &str, name: &str, rect: Rect, action: &str, listed: &[NodeAction]| {
            let mut node = Node::new(id, Role::Button, name, rect);
            node.actions = listed
                .iter()
                .filter(|a| a.id.as_str() == action)
                .cloned()
                .collect();
            node.state.disabled = node.actions.iter().any(|a| !a.enabled);
            node
        };
        let listed = root.actions.clone();
        if self.asking {
            put(
                &mut root,
                button(
                    "stop-confirm",
                    "Yes, stop the run",
                    lay.primary,
                    actions::STOP_CONFIRM,
                    &listed,
                ),
                &mut out,
            );
            put(
                &mut root,
                button(
                    "stop-cancel",
                    "Keep the run going",
                    lay.secondary,
                    actions::STOP_CANCEL,
                    &listed,
                ),
                &mut out,
            );
        } else if self.running() {
            put(
                &mut root,
                button("stop", "Stop the run", lay.primary, actions::STOP, &listed),
                &mut out,
            );
        } else {
            put(
                &mut root,
                button(
                    "start",
                    "Start the run",
                    lay.primary,
                    actions::START,
                    &listed,
                ),
                &mut out,
            );
        }
        let mut follow = button(
            "follow",
            "Follow the end of the output",
            lay.follow,
            actions::FOLLOW,
            &listed,
        );
        follow.state.selected = self.follow;
        put(&mut root, follow, &mut out);
        if self.can_list {
            let name = if self.picker.is_some() {
                "Close the list of runs"
            } else {
                "List the runs on the host"
            };
            let action = if self.picker.is_some() {
                actions::LIST_CLOSE
            } else {
                actions::LIST
            };
            put(
                &mut root,
                button("runs", name, lay.runs, action, &listed),
                &mut out,
            );
        }
        let mut status = Node::new("status", Role::Status, &words, lay.status);
        status.state.busy = self.running();
        if problem {
            status.role = Role::Alert;
        }
        // What kind of non-answer the owner gave, so an agent can tell a refusal from a
        // failure without parsing the sentence.
        status.state.description = self.told.as_ref().map(|t| t.outcome.to_owned());
        put(&mut root, status, &mut out);

        if let Some(p) = &self.picker {
            let mut tree = Node::new("picker", Role::Tree, "Runs on the host", lay.list);
            tree.state.focused = focused;
            let size = p.runs.len().min(usize::from(u16::MAX)) as u16;
            for (i, run) in p.runs.iter().enumerate().skip(p.top) {
                let y = lay.list.y + 1 + (i - p.top) as u16;
                if y >= lay.list.y + lay.list.height {
                    break;
                }
                let mut item = Node::new(
                    &format!("run:{i}"),
                    Role::TreeItem,
                    &run_line(run),
                    Rect::new(lay.list.x, y, lay.list.width, 1),
                );
                item.pos_in_set = Some((i + 1).min(usize::from(u16::MAX)) as u16);
                item.set_size = Some(size);
                item.state.selected = i == p.sel;
                item.actions = listed
                    .iter()
                    .filter(|a| a.id.as_str() == actions::ATTACH)
                    .cloned()
                    .collect();
                tree.children.push(item.id.clone());
                out.push(item);
            }
            put(&mut root, tree, &mut out);
            let mut all = vec![root];
            all.extend(out);
            return all;
        }
        let first = self.first_row();
        let shown: Vec<String> = self
            .rows
            .iter()
            .skip(first)
            .take(lay.list.height as usize)
            .map(|row| match row {
                Row::Rule(name) => format!("-- {name} --"),
                Row::Text(line) => line.spans.iter().map(|s| s.content.as_ref()).collect(),
            })
            .collect();
        let mut output =
            Node::new("output", Role::Log, "Output", lay.list).with_text(&shown.join("\n"));
        output.state.focused = focused && self.focus == Focus::Output;
        output.state.description = Some(format!(
            "{} rows, showing from row {}, {}. Wire: {}.",
            self.rows.len(),
            first + 1,
            if self.follow {
                "following the end"
            } else {
                "not following"
            },
            self.wire()
        ));
        put(&mut root, output, &mut out);
        let mut all = vec![root];
        all.extend(out);
        all
    }
}

/// The pieces of one listed run's row. The state is said as it is for a followed run
/// ("running", "exited with code 101", "exited (no code given)"); a code the host did not
/// give is never read as 0, and a kind the host did not give is never made up.
struct RunParts {
    state: String,
    /// The run ended with a non-zero code.
    bad: bool,
    name: String,
    kind: Option<String>,
    tail: String,
}

fn run_parts(run: &RunSummary) -> RunParts {
    let word = Word {
        word: run.state.clone(),
        code: run.exit_code.map(i64::from),
    };
    let mut tail = String::new();
    if let Some(argv) = &run.command {
        tail.push_str("  ");
        tail.push_str(&argv.join(" "));
    }
    tail.push_str(&format!("  [{}]", run.handle));
    RunParts {
        state: word.describe(),
        bad: run.exit_code.is_some_and(|c| c != 0),
        name: run.name.clone().unwrap_or_else(|| "(unnamed)".to_owned()),
        kind: run.kind.clone(),
        tail,
    }
}

/// One listed run as plain text, for the semantic tree.
fn run_line(run: &RunSummary) -> String {
    let p = run_parts(run);
    let kind = p.kind.map(|k| format!(" ({k})")).unwrap_or_default();
    format!("{}  {}{kind}{}", p.state, p.name, p.tail)
}

/// One listed run drawn in `width` cells: the state in the error role when the run ended
/// with a non-zero code, the kind muted beside the name. A kind that does not fit whole next
/// to the name is dropped before the name is cut.
fn run_row(
    run: &RunSummary,
    width: usize,
    base: Style,
    s: &Styles,
    selected: bool,
) -> Line<'static> {
    let p = run_parts(run);
    let (state_style, kind_style) = if selected {
        (base, base)
    } else if p.bad {
        (s.error, s.muted)
    } else {
        (base, s.muted)
    };
    let mut spans = vec![
        Span::styled(p.state.clone(), state_style),
        Span::styled("  ", base),
        Span::styled(p.name.clone(), base),
    ];
    if let Some(kind) = &p.kind {
        let label = format!("  {kind}");
        let upto = text::width(&p.state) + 2 + text::width(&p.name) + text::width(&label);
        if upto <= width {
            spans.push(Span::styled(label, kind_style));
        }
    }
    spans.push(Span::styled(p.tail, base));
    Line::from(spans)
}

struct ChipLabels {
    primary: &'static str,
    secondary: &'static str,
    runs: &'static str,
    follow: &'static str,
}

struct Layout {
    name: Rect,
    command: Rect,
    status: Rect,
    primary: Rect,
    secondary: Rect,
    runs: Rect,
    follow: Rect,
    list: Rect,
}

/// The rows the status line may take when it is long.
const STATUS_ROWS: usize = 3;

fn layout(area: Rect, labels: &ChipLabels, status_rows: u16) -> Layout {
    let row = |y: u16, x: u16, w: u16| {
        if y < area.height && w > 0 && x < area.width {
            Rect::new(area.x + x, area.y + y, w.min(area.width - x), 1)
        } else {
            Rect::default()
        }
    };
    let field_x = LABEL.min(area.width);
    let field_w = area.width.saturating_sub(field_x);
    // The chips sit at the end of the status row; the status words take what is left.
    let widths = [labels.primary, labels.secondary, labels.runs, labels.follow]
        .map(|l| text::width(l) as u16);
    let total: u16 = widths.iter().filter(|w| **w > 0).map(|w| w + 1).sum();
    let chips_fit = total + 12 <= area.width;
    let mut x = area.width.saturating_sub(total);
    let mut place = |w: u16| {
        if !chips_fit || w == 0 {
            return Rect::default();
        }
        let r = row(2, x, w);
        x += w + 1;
        r
    };
    let primary = place(widths[0]);
    let secondary = place(widths[1]);
    let runs = place(widths[2]);
    let follow = place(widths[3]);
    let status_w = if chips_fit {
        area.width.saturating_sub(total + 1)
    } else {
        area.width
    };
    let status_rows = status_rows.min(area.height.saturating_sub(2)).max(1);
    let top = (2 + status_rows).min(area.height);
    let mut status = row(2, 0, status_w);
    if status.width > 0 {
        status.height = status_rows;
    }
    Layout {
        name: row(0, field_x, field_w),
        command: row(1, field_x, field_w),
        status,
        primary,
        secondary,
        runs,
        follow,
        list: Rect::new(area.x, area.y + top, area.width, area.height - top),
    }
}

/// The line with its 16 named ANSI colours replaced by the theme's, so run output matches the
/// terminal pane's palette. A colour the host did not set (`Reset`) is left as the program
/// wrote it.
fn remap(line: &Line<'static>, ansi: &[Color; 16]) -> Line<'static> {
    let pick = |c: Option<Color>| {
        let index = match c? {
            Color::Black => 0,
            Color::Red => 1,
            Color::Green => 2,
            Color::Yellow => 3,
            Color::Blue => 4,
            Color::Magenta => 5,
            Color::Cyan => 6,
            Color::Gray => 7,
            Color::DarkGray => 8,
            Color::LightRed => 9,
            Color::LightGreen => 10,
            Color::LightYellow => 11,
            Color::LightBlue => 12,
            Color::LightMagenta => 13,
            Color::LightCyan => 14,
            Color::White => 15,
            Color::Indexed(n) if n < 16 => usize::from(n),
            other => return Some(other),
        };
        Some(match ansi[index] {
            Color::Reset => c?,
            themed => themed,
        })
    };
    let mut out = line.clone();
    for span in &mut out.spans {
        span.style.fg = pick(span.style.fg);
        span.style.bg = pick(span.style.bg);
    }
    out
}

/// One run of output as rows: line breaks are the host's, a carriage return keeps only what
/// follows it (a progress line redrawn in place), and a tab goes to the next stop of four.
fn normalise(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    for (n, line) in body.split('\n').enumerate() {
        if n > 0 {
            out.push('\n');
        }
        let line = line.rsplit('\r').find(|l| !l.is_empty()).unwrap_or("");
        let mut column = 0usize;
        let mut in_escape = false;
        for c in line.chars() {
            if in_escape {
                out.push(c);
                if c.is_ascii_alphabetic() {
                    in_escape = false;
                }
                continue;
            }
            match c {
                '\u{1b}' => {
                    in_escape = true;
                    out.push(c);
                }
                '\t' => {
                    let stop = (column / text::TAB + 1) * text::TAB;
                    out.extend(std::iter::repeat_n(' ', stop - column));
                    column = stop;
                }
                c if c.is_control() => {
                    out.push('?');
                    column += 1;
                }
                c => {
                    out.push(c);
                    column += text::width(c.encode_utf8(&mut [0; 4]));
                }
            }
        }
    }
    out
}

/// The output as styled lines. A parse that fails falls back to the text unstyled.
fn lines_of(body: &str) -> Vec<Line<'static>> {
    let clean = normalise(body);
    let mut lines = match clean.into_text() {
        Ok(parsed) => parsed.lines,
        Err(_) => clean.lines().map(|l| Line::from(l.to_owned())).collect(),
    };
    if body.ends_with('\n') && lines.last().is_some_and(|l| l.spans.is_empty()) {
        lines.pop();
    }
    lines
}

impl Panel for RunPanel {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        self.adopt(cx.workspace());
        self.can_start = cx.capabilities().has(&Capability::new(START_CAPABILITY));
        self.can_read = cx.capabilities().has(&Capability::new(READ_CAPABILITY));
        self.can_list = cx.capabilities().has(&Capability::new(LIST_CAPABILITY));
        match msg {
            PanelMsg::Key(key) => self.on_key(key, cx),
            PanelMsg::Pointer(p) => self.on_pointer(p, cx),
            PanelMsg::Resize { area, .. } => {
                self.area = Rect::new(0, 0, area.width, area.height);
                self.top = self.top.min(self.bottom());
            }
            PanelMsg::Completion(c) => self.on_completion(c, cx),
            PanelMsg::Action(id) => self.on_action(&id, cx),
            PanelMsg::Tick => self.on_tick(cx),
            // A mismatched answer is not this run's.
            _ => {}
        }
    }

    fn view(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        self.draw(area, buf, cx.focused, &Styles::from_theme(cx.theme));
    }

    fn semantics(&self, area: Rect, cx: &ViewCtx) -> Vec<Node> {
        let mut nodes = self.nodes(area, cx.focused);
        if let (Some(root), Some(b)) = (nodes.first_mut(), self.binding()) {
            root.binding = b.resource;
        }
        nodes
    }

    fn serialize(&self) -> Value {
        serde_json::to_value(ViewState {
            name: self.name.value().to_owned(),
            command: self.command.value().to_owned(),
            follow: self.follow,
            scroll: self.top,
            handle: self.handle.clone(),
        })
        .unwrap_or(Value::Null)
    }

    fn tab_label(&self) -> Option<TabLabel> {
        let state = self.state.as_ref()?;
        let title = if state.running() {
            "Run output (running)".to_owned()
        } else {
            format!("Run output ({})", state.describe())
        };
        Some(TabLabel {
            title,
            modified: false,
        })
    }

    fn binding(&self) -> Option<Binding> {
        Some(Binding {
            resource: ResourceRef::Workspace {
                workspace: self.identity.workspace.clone(),
            },
            revision: None,
            generation: Some(Generation(self.identity.generation.0)),
        })
    }

    fn text_entry(&self) -> bool {
        self.focus != Focus::Output && self.picker.is_none()
    }

    /// Closing the view sends nothing: the run belongs to the host, and a stop is its own
    /// action behind its own confirmation.
    fn teardown(&mut self, _cx: &mut Ctx, _destroy: bool) {}
}

pub(crate) fn kind() -> PanelKind {
    PanelKind::new(KIND)
}

/// The registry entries. Starting and polling are `Start`; stopping is a `Destroy` that asks,
/// and its confirmation is human-only, so an agent can request a stop and never approve it.
pub(crate) fn descriptors() -> Vec<ActionDescriptor> {
    let local =
        |id: &str, title: &str| ActionDescriptor::local(id, title).requires(READ_CAPABILITY);
    vec![
        ActionDescriptor::new(actions::START, "Start the named run", ActionIntent::Start)
            .requires(START_CAPABILITY)
            .emits(EffectKind::RunConfigure)
            .emits(EffectKind::RunStart),
        ActionDescriptor::new(actions::STOP, "Ask to stop the run", ActionIntent::Destroy)
            .requires(START_CAPABILITY)
            .emits(EffectKind::RunStop),
        ActionDescriptor::new(
            actions::STOP_CONFIRM,
            "Confirm the question the panel asked: stop the run",
            ActionIntent::Destroy,
        )
        .requires(START_CAPABILITY)
        .emits(EffectKind::RunStop)
        .human_only(),
        local(actions::STOP_CANCEL, "Keep the run going"),
        ActionDescriptor::new(actions::REFRESH, "Read the run again", ActionIntent::Start)
            .requires(READ_CAPABILITY)
            .emits(EffectKind::RunPoll),
        ActionDescriptor::new(
            actions::LIST,
            "List the runs on the host",
            ActionIntent::Start,
        )
        .requires(LIST_CAPABILITY)
        .emits(EffectKind::RunList),
        ActionDescriptor::local(actions::LIST_UP, "Select the previous listed run")
            .requires(LIST_CAPABILITY),
        ActionDescriptor::local(actions::LIST_DOWN, "Select the next listed run")
            .requires(LIST_CAPABILITY),
        ActionDescriptor::new(
            actions::ATTACH,
            "Show the selected listed run here and read it",
            ActionIntent::Start,
        )
        .requires(LIST_CAPABILITY)
        .requires(READ_CAPABILITY)
        .emits(EffectKind::RunPoll),
        ActionDescriptor::local(actions::LIST_CLOSE, "Close the list of runs")
            .requires(LIST_CAPABILITY),
        local(
            actions::FOLLOW,
            "Follow the end of the output, or stop following",
        ),
        local(actions::NEXT_FIELD, "Move to the next field or the output"),
        local(actions::SCROLL_UP, "Scroll the output up a page"),
        local(actions::SCROLL_DOWN, "Scroll the output down a page"),
        local(
            actions::SCROLL_END,
            "Scroll to the end of the output and follow it",
        ),
    ]
}
